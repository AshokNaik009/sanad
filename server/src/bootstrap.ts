// Composition root shared by the server, scripts and tests.
import { Llm } from "./ai/llm.ts";
import { type Config, readConfig } from "./config.ts";
import { type Store, createStore } from "./db.ts";
import { HttpGatewayAdapter } from "./gateway/adapter.ts";
import { createMockGateway } from "./gateway/mock-gateway.ts";
import { type SeedOptions, seed } from "./seed.ts";
import { AuditLog } from "./services/audit.ts";
import { Platform } from "./services/platform.ts";

const IN_PROCESS = "http://mock-gateway.internal";

export async function bootstrap(overrides: Partial<Config> = {}, store?: Store) {
  const config = { ...readConfig(), ...overrides };
  const db =
    store ?? (await createStore({ dataDir: `${config.dataDir}/postgres`, databaseUrl: config.databaseUrl }));
  const mockGateway = createMockGateway(db, { adjudicationDelaySeconds: config.adjudicationDelaySeconds });
  // Without GATEWAY_URL the adapter speaks HTTP (Request/Response) to the in-process mock gateway.
  const external = !!process.env.GATEWAY_URL && !overrides.gatewayUrl;
  const baseUrl = external ? config.gatewayUrl : IN_PROCESS;
  const fetcher: typeof fetch = external
    ? fetch
    : (input, init) => {
        const url = new URL(String(input));
        return Promise.resolve(mockGateway.request(`${url.pathname}${url.search}`, init));
      };
  const gateway = new HttpGatewayAdapter(baseUrl, fetcher);
  const llm = new Llm(config, db);
  const audit = new AuditLog(db);
  const platform = new Platform(db, config, llm, gateway, audit);

  const gatewayAdmin = async (path: string, body: unknown) => {
    const res = await fetcher(`${baseUrl}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`Gateway admin ${path} failed: ${res.status}`);
  };
  const reset = (options: SeedOptions = {}) => seed(platform, gatewayAdmin, options);
  const releaseRemittances = async () => {
    const res = await fetcher(`${baseUrl}/admin/release`, { method: "POST" });
    return (await res.json()) as { released: number };
  };
  return { config, store: db, platform, mockGateway, reset, releaseRemittances };
}

/** Background task engine: remittance polling, prior-auth status, deadline alerts, with backoff. */
export function startWorker(platform: Platform, intervalMs = 4000) {
  let stopped = false;
  let failures = 0;
  let timer: NodeJS.Timeout | undefined;
  const tick = async () => {
    try {
      await platform.pollRemittances();
      await platform.refreshPriorAuths();
      await platform.deadlineAlerts();
      failures = 0;
    } catch (error) {
      failures++;
      console.warn(`[worker] tick failed (${failures}): ${(error as Error).message}`);
    }
    if (!stopped) timer = setTimeout(tick, Math.min(60_000, intervalMs * 2 ** failures));
  };
  timer = setTimeout(tick, intervalMs);
  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
  };
}
