// Provider-agnostic structured-output client. Every task asks for JSON matching a Zod schema,
// validates it, retries once with the validation error, and falls back along the provider chain
// (default: Groq, then OpenRouter). Responses are cached so the demo path survives network loss.
import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { z } from "zod";
import type { Config } from "../config.ts";
import type { Store } from "../db.ts";
import { AppError, sha256 } from "../util.ts";

const CACHE_OWNER = "system";

export type ProviderName = "groq" | "openrouter" | "anthropic";

interface StructuredRequest<S extends z.ZodType> {
  task: string;
  schema: S;
  system: string;
  user: string;
  effort?: "low" | "medium" | "high";
  maxTokens?: number;
}

interface Provider {
  name: ProviderName;
  model: string;
  complete(req: StructuredRequest<z.ZodType>, extra?: string): Promise<unknown>;
}

/** Pull the JSON object out of a chat completion (tolerates fences and <think> blocks). */
export function extractJson(text: string): unknown {
  const cleaned = text.replace(/<think>[\s\S]*?<\/think>/gi, "").replace(/```(?:json)?/gi, "").trim();
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("Model reply contained no JSON object");
  return JSON.parse(cleaned.slice(start, end + 1));
}

function schemaInstruction(schema: z.ZodType): string {
  return `Reply with ONLY one JSON object (no prose, no markdown) that validates against this JSON Schema:\n${JSON.stringify(z.toJSONSchema(schema))}`;
}

/** OpenAI-compatible chat completions (Groq, OpenRouter). */
function chatProvider(options: {
  name: "groq" | "openrouter";
  url: string;
  apiKey: string;
  model: string;
  jsonMode: boolean;
  headers?: Record<string, string>;
  body?: Record<string, unknown>;
}): Provider {
  return {
    name: options.name,
    model: options.model,
    async complete(req, extra) {
      const messages = [
        { role: "system", content: `${req.system}\n\n${schemaInstruction(req.schema)}` },
        { role: "user", content: req.user },
        ...(extra ? [{ role: "user", content: extra }] : []),
      ];
      let response: Response;
      try {
        response = await fetch(options.url, {
          method: "POST",
          headers: { Authorization: `Bearer ${options.apiKey}`, "Content-Type": "application/json", ...options.headers },
          body: JSON.stringify({
            model: options.model,
            messages,
            temperature: 0.1,
            max_tokens: req.maxTokens ?? 4096,
            ...(options.jsonMode ? { response_format: { type: "json_object" } } : {}),
            ...options.body,
          }),
          signal: AbortSignal.timeout(60_000),
        });
      } catch (error) {
        throw new Error(`${options.name} unreachable: ${(error as Error).message}`);
      }
      const body = (await response.json().catch(() => ({}))) as {
        choices?: { message?: { content?: string }; finish_reason?: string }[];
        error?: { message?: string };
      };
      if (!response.ok) throw new Error(`${options.name} ${response.status}: ${body.error?.message ?? "request failed"}`);
      const content = body.choices?.[0]?.message?.content;
      if (!content) throw new Error(`${options.name} returned an empty reply`);
      return extractJson(content);
    },
  };
}

function anthropicProvider(model: string): Provider {
  const client = new Anthropic();
  return {
    name: "anthropic",
    model,
    async complete(req) {
      const response = await client.beta.messages.parse({
        model,
        max_tokens: req.maxTokens ?? 16000,
        betas: ["server-side-fallback-2026-07-01"],
        fallbacks: "default",
        system: req.system,
        messages: [{ role: "user", content: req.user }],
        output_config: { format: betaZodOutputFormat(req.schema), effort: req.effort ?? "medium" },
      });
      if (response.stop_reason === "refusal") throw new Error("anthropic declined the request");
      if (response.parsed_output == null) throw new Error("anthropic reply did not match the schema");
      return response.parsed_output;
    },
  };
}

export function buildProviders(config: Config, env: NodeJS.ProcessEnv = process.env): Provider[] {
  const out: Provider[] = [];
  for (const name of config.llmProviders) {
    if (name === "groq" && env.GROQ_API_KEY)
      out.push(chatProvider({ name, url: "https://api.groq.com/openai/v1/chat/completions", apiKey: env.GROQ_API_KEY, model: env.GROQ_MODEL ?? "openai/gpt-oss-120b", jsonMode: true }));
    if (name === "openrouter" && env.OPENROUTER_API_KEY) {
      const order = (env.OPENROUTER_PROVIDER_ORDER ?? env.REG_COMPARE_PROVIDER_ORDER ?? "").split(",").map((s) => s.trim()).filter(Boolean);
      out.push(
        chatProvider({
          name,
          url: "https://openrouter.ai/api/v1/chat/completions",
          apiKey: env.OPENROUTER_API_KEY,
          model: env.OPENROUTER_MODEL ?? env.REG_COMPARE_MODEL ?? "minimax/minimax-m3:free",
          jsonMode: false,
          headers: { "HTTP-Referer": config.publicUrl, "X-Title": "Sanad" },
          body: order.length ? { provider: { order, allow_fallbacks: true } } : undefined,
        }),
      );
    }
    if (name === "anthropic" && (env.ANTHROPIC_API_KEY || env.ANTHROPIC_AUTH_TOKEN)) out.push(anthropicProvider(config.model));
  }
  return out;
}

export class Llm {
  private readonly providers: Provider[];
  constructor(
    private readonly config: Config,
    private readonly store: Store,
    providers?: Provider[],
  ) {
    this.providers = config.aiMode === "model" ? (providers ?? buildProviders(config)) : [];
  }

  get enabled(): boolean {
    return this.providers.length > 0;
  }

  get engine(): "sample" | "model" {
    return this.enabled ? "model" : "sample";
  }

  get label(): string {
    return this.enabled ? this.providers.map((p) => `${p.name}:${p.model}`).join(" → ") : "offline engine";
  }

  async structured<S extends z.ZodType>(req: StructuredRequest<S>): Promise<z.output<S>> {
    if (!this.enabled) throw new AppError("No AI provider is configured (AI_MODE=sample)", 503);
    const key = sha256(JSON.stringify([this.label, req.task, req.system, req.user]));
    const cached = await this.store.get<{ id: string; value: unknown }>(CACHE_OWNER, "llm_cache", key);
    if (cached) {
      const hit = req.schema.safeParse(cached.value);
      if (hit.success) return hit.data;
    }
    const errors: string[] = [];
    for (const provider of this.providers) {
      let retryNote: string | undefined;
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const raw = await provider.complete(req, retryNote);
          const parsed = req.schema.safeParse(raw);
          if (parsed.success) {
            await this.store.put(CACHE_OWNER, "llm_cache", { id: key, value: parsed.data, provider: provider.name });
            return parsed.data;
          }
          retryNote = `Your previous JSON failed validation: ${parsed.error.issues.slice(0, 5).map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}. Return corrected JSON only.`;
          errors.push(`${provider.name}: invalid JSON shape`);
        } catch (error) {
          errors.push((error as Error).message);
          break; // transport/provider error: move to the next provider
        }
      }
    }
    console.warn(`[llm] ${req.task} failed on all providers: ${errors.join(" | ")}`);
    throw new AppError(`AI providers unavailable for ${req.task}; continue manually or retry`, 502);
  }
}
