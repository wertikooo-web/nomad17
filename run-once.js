const nativeFetch = globalThis.fetch.bind(globalThis);

// Apply the OpenRouter profile before the agent is imported.
// Important: do not read/clone the response here. The agent owns the response body
// and its AbortController must remain the single timeout authority.
globalThis.fetch = async function nomadFetch(input, init = {}) {
  const url = typeof input === "string" ? input : input?.url || "";
  if (!url.includes("/chat/completions") || !init?.body) {
    return nativeFetch(input, init);
  }

  let body;
  try { body = JSON.parse(init.body); }
  catch { return nativeFetch(input, init); }

  const model = String(body?.model || "");
  if (model === "stealth/ox-alpha") {
    body.reasoning = { effort: "low", exclude: true };
    body.max_tokens = Math.max(Number(body.max_tokens) || 0, 8000);
    body.temperature = 0.2;
    console.log(`[OpenRouter] Ox Alpha profile applied: reasoning=low, max_tokens=${body.max_tokens}`);
  }

  return nativeFetch(input, { ...init, body: JSON.stringify(body) });
};

try {
  const { runCycle } = await import("./src/agent.js");
  const result = await runCycle({ reason: process.env.GITHUB_ACTIONS ? "github-actions" : "manual" });
  console.log(JSON.stringify(result, null, 2));
} catch (err) {
  console.error(err?.stack || err?.message || String(err));
  process.exitCode = 1;
}
