// One-click reset: restores the seeded demo state (PRD demo-day checklist).
// Usage: npm run reset-demo [-- --release]   (--release lands the held payer remittance run now)
import { bootstrap } from "../server/src/bootstrap.ts";

const started = Date.now();
const { reset, store } = await bootstrap();
const summary = await reset({ releaseRemittances: process.argv.includes("--release") });
console.log(JSON.stringify(summary, null, 2));
console.log(`Demo reset in ${((Date.now() - started) / 1000).toFixed(1)}s`);
await store.close();
