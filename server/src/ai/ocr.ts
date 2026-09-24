// Vision OCR for scanned notes (M1.1). Each page walks the vision-model chain in order: Groq first,
// then the OpenRouter models. A rate limit or 5xx gets one short retry on the same model; any other
// failure (timeout, empty reply, unknown model) falls straight through to the next one. Results are
// cached by image hash, so a page read once is never sent to a provider again.
import type { Config } from "../config.ts";
import type { Store } from "../db.ts";
import { AppError, sha256 } from "../util.ts";

const CACHE_OWNER = "system";
const TIMEOUT_MS = 45_000;
const MAX_RETRY_WAIT_MS = 4_000;

const PROMPT =
  "You are an OCR engine for clinical documents from a UAE clinic. Transcribe ALL text in the image exactly as written, top to bottom, keeping line breaks, headings, numbers, units, dates and drug doses. Do not correct, interpret, translate, summarise or add anything. Write [illegible] for any word you cannot read. If the image contains no text, reply with exactly: [no text]. Output only the transcription.";

export interface VisionModel {
  provider: "groq" | "openrouter";
  model: string;
}

export interface OcrPage {
  page: number;
  text: string;
  provider: string;
  model: string;
  ms: number;
  cached: boolean;
  /** Models that failed before this page was read, with the reason. */
  fellBackFrom: string[];
}

const list = (value: string | undefined, fallback: string) =>
  (value ?? fallback).split(",").map((s) => s.trim()).filter(Boolean);

/** Vision models in provider-chain order. Override with GROQ_VISION_MODELS / OPENROUTER_VISION_MODELS. */
export function visionChain(config: Config, env: NodeJS.ProcessEnv = process.env): VisionModel[] {
  const out: VisionModel[] = [];
  for (const provider of config.llmProviders) {
    if (provider === "groq" && env.GROQ_API_KEY)
      for (const model of list(env.GROQ_VISION_MODELS ?? env.GROQ_VISION_MODEL, "qwen/qwen3.8-27b")) out.push({ provider, model });
    if (provider === "openrouter" && env.OPENROUTER_API_KEY)
      for (const model of list(env.OPENROUTER_VISION_MODELS, "google/gemma-4-31b-it:free,google/gemma-4-26b-a4b-it:free"))
        out.push({ provider, model });
  }
  return out;
}

class RetryableError extends Error {
  constructor(
    message: string,
    readonly waitMs: number,
  ) {
    super(message);
  }
}

function cleanTranscript(text: string): string {
  return text
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    .replace(/^```[a-z]*\n?|\n?```$/gim, "")
    .trim();
}

export class Ocr {
  readonly chain: VisionModel[];
  constructor(
    private readonly config: Config,
    private readonly store: Store,
    private readonly env: NodeJS.ProcessEnv = process.env,
    private readonly fetcher: typeof fetch = fetch,
  ) {
    this.chain = config.aiMode === "model" ? visionChain(config, env) : [];
  }

  get enabled(): boolean {
    return this.chain.length > 0;
  }

  get label(): string {
    return this.enabled ? this.chain.map((m) => `${m.provider}:${m.model}`).join(" → ") : "unavailable";
  }

  /** Transcribe page images (data: URLs). Pages are read one at a time so each can fall back on its own. */
  async read(pages: string[]): Promise<{ text: string; pages: OcrPage[] }> {
    if (!this.enabled) {
      console.warn("[ocr] no vision model configured: set AI_MODE=model and GROQ_API_KEY or OPENROUTER_API_KEY");
      throw new AppError("Reading scans isn't available right now. Please paste the note text instead.", 503);
    }
    const out: OcrPage[] = [];
    for (const [i, image] of pages.entries()) out.push(await this.readPage(i + 1, image));
    const text = out
      .map((p) => (pages.length > 1 ? `--- Page ${p.page} ---\n${p.text}` : p.text))
      .join("\n\n");
    return { text, pages: out };
  }

  private async readPage(page: number, image: string): Promise<OcrPage> {
    const key = sha256(`ocr:v1:${image}`);
    const cached = await this.store.get<{ id: string; text: string; provider: string; model: string }>(CACHE_OWNER, "ocr_cache", key);
    if (cached) return { page, text: cached.text, provider: cached.provider, model: cached.model, ms: 0, cached: true, fellBackFrom: [] };

    const failures: string[] = [];
    for (const vm of this.chain) {
      for (let attempt = 0; attempt < 2; attempt++) {
        const started = Date.now();
        try {
          const text = await this.call(vm, image);
          await this.store.put(CACHE_OWNER, "ocr_cache", { id: key, text, provider: vm.provider, model: vm.model });
          if (failures.length) console.warn(`[ocr] page ${page} read by ${vm.provider}:${vm.model} after: ${failures.join(" | ")}`);
          return { page, text, provider: vm.provider, model: vm.model, ms: Date.now() - started, cached: false, fellBackFrom: failures };
        } catch (error) {
          if (error instanceof RetryableError && attempt === 0) {
            await new Promise((r) => setTimeout(r, error.waitMs));
            continue;
          }
          failures.push(`${vm.model}: ${(error as Error).message}`);
          break;
        }
      }
    }
    console.warn(`[ocr] page ${page} failed on every vision model: ${failures.join(" | ")}`);
    throw new AppError(
      `We couldn't read ${page > 1 ? `page ${page} of ` : ""}this scan right now. Try again in a minute, or paste the note text.`,
      502,
    );
  }

  private async call(vm: VisionModel, image: string): Promise<string> {
    const openrouter = vm.provider === "openrouter";
    const url = openrouter ? "https://openrouter.ai/api/v1/chat/completions" : "https://api.groq.com/openai/v1/chat/completions";
    const apiKey = openrouter ? this.env.OPENROUTER_API_KEY : this.env.GROQ_API_KEY;
    let response: Response;
    try {
      response = await this.fetcher(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
          ...(openrouter ? { "HTTP-Referer": this.config.publicUrl, "X-Title": "Sanad" } : {}),
        },
        body: JSON.stringify({
          model: vm.model,
          temperature: 0,
          max_tokens: 4096,
          messages: [
            {
              role: "user",
              content: [
                { type: "text", text: PROMPT },
                { type: "image_url", image_url: { url: image } },
              ],
            },
          ],
        }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (error) {
      const reason = (error as Error).name === "TimeoutError" ? `timed out after ${TIMEOUT_MS / 1000}s` : `unreachable (${(error as Error).message})`;
      throw new Error(reason);
    }
    const body = (await response.json().catch(() => ({}))) as {
      choices?: { message?: { content?: string } }[];
      error?: { message?: string; metadata?: { raw?: string } };
    };
    if (!response.ok) {
      const reason = `${response.status} ${body.error?.metadata?.raw ?? body.error?.message ?? "request failed"}`;
      if (response.status === 429 || response.status >= 500) {
        const retryAfter = Number(response.headers.get("retry-after"));
        throw new RetryableError(reason, Math.min(MAX_RETRY_WAIT_MS, Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 1500));
      }
      throw new Error(reason);
    }
    const text = cleanTranscript(body.choices?.[0]?.message?.content ?? "");
    if (!text) throw new Error("empty reply");
    return text;
  }
}
