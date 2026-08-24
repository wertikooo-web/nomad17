import { runCycle } from "./src/agent.js";

try {
  const result = await runCycle({ reason: process.env.GITHUB_ACTIONS ? "github-actions" : "manual" });
  console.log(JSON.stringify(result, null, 2));
} catch (err) {
  console.error(err?.stack || err?.message || String(err));
  process.exitCode = 1;
}
