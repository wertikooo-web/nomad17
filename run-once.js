const nativeFetch = globalThis.fetch.bind(globalThis);

// Reliability policy for OpenRouter calls.
// Ox Alpha is useful for agentic reasoning, but it is a preview model and can be slow.
// Give it a bounded first attempt, then fall back instead of letting the whole GitHub job die at 120s.
globalThis.fetch = async function nomadFetch(input, init = {}) {
  const url = typeof input === "string" ? input : input?.url || "";
  if (!url.includes("/chat/completions") || !init?.body) {
    return nativeFetch(input, init);
  }

  let body;
  try { body = JSON.parse(init.body); }
  catch { return nativeFetch(input, init); }

  const originalModel = String(body?.model || "");
  if (originalModel !== "stealth/ox-alpha") {
    return nativeFetch(input, init);
  }

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
    console.log("[router] primary stealth/ox-alpha budget=35s reasoning=low");
    const response = await nativeFetch(input, {
      ...init,
      signal: primaryController.signal,
      body: JSON.stringify(primaryBody),
    });
    console.log(`[router] primary headers status=${response.status} in ${Date.now() - primaryStarted}ms`);
    return response;
  } catch (error) {
    if (callerSignal?.aborted) throw error;
    console.warn(`[router] Ox Alpha unavailable after ${Date.now() - primaryStarted}ms: ${error?.message || error}`);
  } finally {
    clearTimeout(primaryTimer);
    if (callerSignal) callerSignal.removeEventListener("abort", onCallerAbort);
  }

  // Fast rescue path. This request is still governed by agent.js's outer AbortController,
  // so the complete LLM phase remains bounded.
  const fallbackModel = process.env.OPENAI_FALLBACK_MODEL || "openrouter/auto";
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
    body: JSON.stringify(fallbackBody),
  });
};

let exitCode = 0;
try {
  console.log(`[run-once] model=${process.env.OPENAI_MODEL || "unset"} fallback=${process.env.OPENAI_FALLBACK_MODEL || "openrouter/auto"}`);
  const { runCycle } = await import("./src/agent.js");
  const result = await runCycle({ reason: process.env.GITHUB_ACTIONS ? "github-actions" : "manual" });
  console.log(JSON.stringify(result, null, 2));
} catch (err) {
  exitCode = 1;
  console.error(err?.stack || err?.message || String(err));
}

// Do not let keep-alive sockets or provider connections keep the runner alive until GNU timeout kills it.
// All durable writes inside runCycle have completed before this point.
console.log(`[run-once] exiting code=${exitCode}`);
process.exit(exitCode);
