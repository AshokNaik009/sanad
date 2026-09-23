import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

if (existsSync(".env")) process.loadEnvFile(".env");

export interface Config {
  port: number;
  host: string;
  publicUrl: string;
  dataDir: string;
  databaseUrl?: string;
  /** "sample" runs the deterministic AI engine; "model" calls Claude with structured outputs. */
  aiMode: "sample" | "model";
  /** Provider chain for AI_MODE=model, tried in order (default groq, then openrouter). */
  llmProviders: ("groq" | "openrouter" | "anthropic")[];
  /** Claude model when "anthropic" is in the chain. */
  model: string;
  /** 32-byte key for AES-256-GCM encryption of identifiers such as Emirates ID. */
  encryptionKey: Buffer;
  gatewayUrl: string;
  /** Seconds the mock gateway waits before adjudicating a submitted claim. */
  adjudicationDelaySeconds: number;
  taskWorkerEnabled: boolean;
  /** Reconciliation variance (AED) above which a paid line is flagged as underpaid. */
  underpaymentThreshold: number;
  allowedOrigins: string[];
  production: boolean;
}

export function readConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const port = Number(env.PORT ?? 8788);
  const publicUrl = env.PUBLIC_API_URL ?? `http://localhost:${port}`;
  const aiMode = env.AI_MODE ?? "sample";
  if (aiMode !== "sample" && aiMode !== "model") throw new Error("AI_MODE must be sample or model");
  const rawKey = env.SANAD_ENCRYPTION_KEY;
  let encryptionKey: Buffer;
  if (rawKey) {
    encryptionKey = Buffer.from(rawKey, "base64");
    if (encryptionKey.length !== 32)
      throw new Error("SANAD_ENCRYPTION_KEY must be 32 random bytes encoded as base64");
  } else {
    if (env.NODE_ENV === "production")
      throw new Error("SANAD_ENCRYPTION_KEY is required in production");
    // Synthetic-data development key. Never used when a real key is configured.
    encryptionKey = createHash("sha256").update("sanad-synthetic-dev-key").digest();
  }
  return {
    port,
    host: env.HOST ?? "127.0.0.1",
    publicUrl,
    dataDir: resolve(env.DATA_DIR ?? ".sanad"),
    databaseUrl: env.DATABASE_URL,
    aiMode,
    llmProviders: (env.LLM_PROVIDERS ?? "groq,openrouter")
      .split(",")
      .map((p) => p.trim())
      .filter((p): p is "groq" | "openrouter" | "anthropic" => ["groq", "openrouter", "anthropic"].includes(p)),
    model: env.SANAD_MODEL ?? "claude-opus-5",
    encryptionKey,
    gatewayUrl: env.GATEWAY_URL ?? `${publicUrl}/mock-gateway`,
    adjudicationDelaySeconds: Number(env.ADJUDICATION_DELAY_SECONDS ?? 6),
    taskWorkerEnabled: env.TASK_WORKER_ENABLED !== "false",
    underpaymentThreshold: Number(env.UNDERPAYMENT_THRESHOLD_AED ?? 5),
    allowedOrigins: (env.ALLOWED_ORIGINS ?? "http://localhost:5173,http://127.0.0.1:5173").split(
      ",",
    ),
    production: env.NODE_ENV === "production",
  };
}
