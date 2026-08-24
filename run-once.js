const nativeFetch = globalThis.fetch.bind(globalThis);

// Reliability policy for OpenRouter calls.
// Ox Alpha is preferred, but it counts as successful only after a complete valid JSON body arrives.
globalThis.fetch = async function nomadFetch(input, init = {}) {
  const url = typeof input === "string" ? input : input?.url || "";
  if (!url.includes("/chat/completions") || !init?.body) return nativeFetch(input, init);

  let body;
  try { body = JSON.parse(init.body); }
  catch { return nativeFetch(input, init); }

  const originalModel = String(body?.model || "");
  if (originalModel !== "stealth/ox-alpha") return nativeFetch(input, init);

  const callerSignal = init.signal;
  const primaryController = new AbortController();
  const onCallerAbort = () => primaryController.abort(callerSignal?.reason);
  if (callerSignal) {
    if (callerSignal.aborted) primaryController.abort(callerSignal.reason);
    else callerSignal.addEventListener("abort", onCallerAbort, { once: true });
  }

  const primaryBody = {
    ...body,
    model: "stealth/ox-alpha",
    reasoning: { effort: "low", exclude: true },
    max_tokens: 5000,
    temperature: 0.2,
  };

  const primaryTimer = setTimeout(() => primaryController.abort(new Error("Ox Alpha primary budget exceeded")), 35000);
  const primaryStarted = Date.now();
  try {
    console.log("[router] primary stealth/ox-alpha full-valid-json budget=35s reasoning=low");
    const response = await nativeFetch(input, {
      ...init,
      signal: primaryController.signal,
      body: JSON.stringify(primaryBody),
    });
    const raw = await response.text();
    console.log(`[router] primary complete status=${response.status} bytes=${raw.length} in ${Date.now() - primaryStarted}ms`);

    if (response.status === 429 || response.status >= 500) {
      console.warn(`[router] Ox Alpha HTTP ${response.status}; switching to free fallback`);
    } else {
      let envelope = null;
      try { envelope = raw ? JSON.parse(raw) : null; } catch {}
      const content = envelope?.choices?.[0]?.message?.content;
      let contentJson = null;
      if (typeof content === "string" && content.trim()) {
        try { contentJson = JSON.parse(content); } catch {}
      }
      if (response.ok && contentJson && typeof contentJson === "object") {
        console.log("[router] Ox Alpha accepted: final content is valid JSON");
        return new Response(raw, { status: response.status, statusText: response.statusText, headers: response.headers });
      }
      if (!response.ok && response.status < 500 && response.status !== 429) {
        return new Response(raw, { status: response.status, statusText: response.statusText, headers: response.headers });
      }
      console.warn(`[router] Ox Alpha unusable final content; switching to free fallback`);
    }
  } catch (error) {
    if (callerSignal?.aborted) throw error;
    console.warn(`[router] Ox Alpha incomplete after ${Date.now() - primaryStarted}ms: ${error?.message || error}`);
  } finally {
    clearTimeout(primaryTimer);
    if (callerSignal) callerSignal.removeEventListener("abort", onCallerAbort);
  }

  const fallbackModel = process.env.OPENAI_FALLBACK_MODEL || "openrouter/free";
  const fallbackBody = {
    ...body,
    model: fallbackModel,
    max_tokens: 4200,
    temperature: 0.2,
  };
  delete fallbackBody.reasoning;
  delete fallbackBody.reasoning_effort;

  console.log(`[router] fallback ${fallbackModel}`);
  return nativeFetch(input, {
    ...init,
    signal: callerSignal,
    body: JSON.stringify(fallbackBody),
  });
};

let exitCode = 0;
try {
  console.log(`[run-once] model=${process.env.OPENAI_MODEL || "unset"} fallback=${process.env.OPENAI_FALLBACK_MODEL || "openrouter/free"}`);
  const { runCycle } = await import("./src/agent.js");
  const result = await runCycle({ reason: process.env.GITHUB_ACTIONS ? "github-actions" : "manual" });
  console.log(JSON.stringify(result, null, 2));
} catch (err) {
  exitCode = 1;
  console.error(err?.stack || err?.message || String(err));
}

console.log(`[run-once] exiting code=${exitCode}`);
process.exit(exitCode);
