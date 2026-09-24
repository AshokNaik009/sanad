// OCR probe: tests each vision model in the chain directly and reports ok, 429 or 402.
// Run from terminal: npm run ocr-probe
import { existsSync } from "node:fs";
import { deflateSync } from "node:zlib";

if (existsSync(".env")) process.loadEnvFile(".env");
// A 64x64 PNG (providers reject images under 32px); a model should answer "[no text]".
const SAMPLE_IMAGE = `data:image/png;base64,${solidPng(64, 64).toString("base64")}`;
function solidPng(width: number, height: number): Buffer {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (buf: Buffer) => {
    let c = 0xffffffff;
    for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type), data]);
    const sum = Buffer.alloc(4);
    sum.writeUInt32BE(crc(body));
    return Buffer.concat([len, body, sum]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 2, 0, 0, 0], 8); // 8-bit RGB
  const rows = Buffer.concat(Array.from({ length: height }, () => Buffer.concat([Buffer.from([0]), Buffer.alloc(width * 3, 0xf0)])));
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", header), chunk("IDAT", deflateSync(rows)), chunk("IEND", Buffer.alloc(0))]);
}

const PROMPT = "You are an OCR engine. Transcribe ALL text in the image exactly as written. If the image contains no text, reply with exactly: [no text]. Output only the transcription.";

const list = (value: string | undefined, fallback: string) =>
  (value ?? fallback).split(",").map((s) => s.trim()).filter(Boolean);

function getVisionModels() {
  const models: Array<{ provider: "groq" | "openrouter"; model: string }> = [];
  
  if (process.env.GROQ_API_KEY) {
    const groqModels = list(process.env.GROQ_VISION_MODELS ?? process.env.GROQ_VISION_MODEL, "qwen/qwen3.8-27b");
    for (const model of groqModels) {
      models.push({ provider: "groq", model });
    }
  }
  
  if (process.env.OPENROUTER_API_KEY) {
    const openrouterModels = list(process.env.OPENROUTER_VISION_MODELS, "google/gemma-4-31b-it:free,google/gemma-4-26b-a4b-it:free");
    for (const model of openrouterModels) {
      models.push({ provider: "openrouter", model });
    }
  }
  
  return models;
}

async function testModel(provider: string, model: string, apiKey: string): Promise<{ provider: string; model: string; status: string; latency: number }> {
  const started = Date.now();
  try {
    const url = provider === "openrouter" ? "https://openrouter.ai/api/v1/chat/completions" : "https://api.groq.com/openai/v1/chat/completions";
    const response = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        ...(provider === "openrouter" ? { "HTTP-Referer": "http://localhost:3000", "X-Title": "Sanad OCR Probe" } : {}),
      },
      body: JSON.stringify({
        model,
        temperature: 0,
        max_tokens: 256,
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: PROMPT },
              { type: "image_url", image_url: { url: SAMPLE_IMAGE } },
            ],
          },
        ],
      }),
      signal: AbortSignal.timeout(45_000),
    });

    const latency = Date.now() - started;
    const body = await response.json().catch(() => ({}));

    if (response.status === 429) {
      return { provider, model, status: "429 (rate limited)", latency };
    }
    if (response.status === 402) {
      return { provider, model, status: "402 (payment required)", latency };
    }
    if (!response.ok) {
      return { provider, model, status: `${response.status} (${body.error?.message ?? "request failed"})`, latency };
    }

    const content = body.choices?.[0]?.message?.content;
    if (!content) {
      return { provider, model, status: "empty reply", latency };
    }

    return { provider, model, status: "ok", latency };
  } catch (error) {
    const latency = Date.now() - started;
    return { provider, model, status: (error as Error).message, latency };
  }
}

async function main() {
  console.log("OCR Probe: testing vision models in the chain...\n");

  const chain = getVisionModels();
  console.log(`Vision chain (${chain.length} models):`);
  chain.forEach((m) => console.log(`  - ${m.provider}:${m.model}`));
  console.log();

  const results = [];
  for (const vm of chain) {
    const apiKey = vm.provider === "openrouter" ? process.env.OPENROUTER_API_KEY : process.env.GROQ_API_KEY;
    if (!apiKey) {
      console.log(`❌ ${vm.provider}:${vm.model} - no API key`);
      continue;
    }
    const result = await testModel(vm.provider, vm.model, apiKey);
    results.push(result);
    const icon = result.status === "ok" ? "✅" : "❌";
    console.log(`${icon} ${result.provider}:${result.model} - ${result.status} (${result.latency}ms)`);
  }

  console.log("\nSummary:");
  const working = results.filter((r) => r.status === "ok");
  const failed = results.filter((r) => r.status !== "ok");
  console.log(`Working: ${working.length}/${results.length}`);
  console.log(`Failed: ${failed.length}/${results.length}`);

  if (failed.length > 0) {
    console.log("\nFailed models:");
    failed.forEach((f) => console.log(`  - ${f.provider}:${f.model}: ${f.status}`));
  }

  if (working.length === 0) {
    console.log("\n⚠️  No working vision models found. You may need to:");
    console.log("  1. Check your API keys");
    console.log("  2. Try different models in GROQ_VISION_MODELS or OPENROUTER_VISION_MODELS");
    console.log("  3. Use non-free models if free tier is exhausted");
  }
}

main().catch((error) => {
  console.error("Error:", error);
  process.exit(1);
});