import { existsSync } from "node:fs";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { createApp } from "./app.ts";
import { bootstrap, startWorker } from "./bootstrap.ts";

const { config, store, platform, agents, mockGateway, reset, releaseRemittances } = await bootstrap();

if ((await store.count(platform.org, "claims")) === 0) {
  console.log("Empty database: seeding the synthetic demo dataset...");
  const summary = await reset();
  console.log("Seeded", summary);
}

const app = createApp(
  { platform, agents, reset: () => reset(), releaseRemittances, accessKey: process.env.SANAD_ACCESS_KEY },
  // The mock gateway (with its admin endpoints) is exposed over HTTP only outside production.
  { allowedOrigins: config.allowedOrigins, mockGateway: config.production ? undefined : mockGateway },
);
if (existsSync("web/dist")) {
  app.use("/*", serveStatic({ root: "web/dist" }));
  app.get("*", serveStatic({ path: "web/dist/index.html" }));
}

// Warm the list cache so the first dashboard load is fast on a remote database.
void Promise.all(
  ["claims", "denials", "remittance_lines", "ai_suggestions", "patients", "encounters"].map((k) => store.list(platform.org, k)),
).catch(() => undefined);

const stopWorker = config.taskWorkerEnabled ? startWorker(platform, 4000, () => agents.proposals.expireHandled()) : () => undefined;
// Daily check of the regulator's published lists (REGULATOR_WATCH=off to disable).
const stopWatch = config.taskWorkerEnabled && process.env.REGULATOR_WATCH !== "off" ? agents.regulatorWatch.schedule() : () => undefined;
const server = serve({ fetch: app.fetch, port: config.port, hostname: config.host }, () =>
  console.log(
    `Sanad API on http://${config.host}:${config.port} (AI: ${platform.llm.label}, DB: ${config.databaseUrl ? "Postgres" : "embedded PGlite"})`,
  ),
);
const shutdown = () => {
  stopWorker();
  stopWatch();
  server.close(() => void store.close().then(() => process.exit(0)));
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
