const nativeFetch = globalThis.fetch.bind(globalThis);

// OpenRouter's Ox Alpha is a mandatory-reasoning model whose default effort is "max".
// Nomad17 needs a bounded reasoning pass plus enough room for the final JSON object.
globalThis.fetch = async function nomadFetch(input, init = {}) {
  const url = typeof input === "string" ? input : input?.url || "";
  if (!url.includes("/chat/completions") || !init?.body) {
    return nativeFetch(input, init);
  }

  let body;
  try { body = JSON.parse(init.body); } catch { return nativeFetch(input, init); }

  const model = String(body?.model || "");
  if (model === "stealth/ox-alpha") {
    body.reasoning_effort = "low";
    body.reasoning = { effort: "low", exclude: true };
    body.max_tokens = Math.max(Number(body.max_tokens) || 0, 8000);
    body.temperature = 0.2;
    console.log(`[OpenRouter] Ox Alpha profile: reasoning=low, max_tokens=${body.max_tokens}`);
  }

  const started = Date.now();
  const response = await nativeFetch(input, { ...init, body: JSON.stringify(body) });
  try {
    const data = await response.clone().json();
    const choice = data?.choices?.[0];
    const content = choice?.message?.content;
    const reasoning = choice?.message?.reasoning;
    console.log(
      `[OpenRouter] model=${model || "?"} status=${response.status} ` +
      `finish=${choice?.finish_reason ?? "?"} content_chars=${typeof content === "string" ? content.length : String(content)} ` +
      `reasoning_chars=${typeof reasoning === "string" ? reasoning.length : reasoning ? "present" : 0} ` +
      `elapsed_ms=${Date.now() - started}`
    );
  } catch (e) {
    console.log(`[OpenRouter] diagnostic parse failed: ${e.message}`);
  }
  return response;
};

try {
  const { runCycle } = await import("./src/agent.js");
  const result = await runCycle({ reason: process.env.GITHUB_ACTIONS ? "github-actions" : "manual" });
  console.log(JSON.stringify(result, null, 2));
} catch (err) {
  console.error(err?.stack || err?.message || String(err));
  process.exitCode = 1;
}
