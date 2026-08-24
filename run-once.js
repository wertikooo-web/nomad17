const nativeFetch = globalThis.fetch.bind(globalThis);

const REGULAR_MODEL = process.env.OPENAI_REGULAR_MODEL || "openai/gpt-oss-20b:free";
const FALLBACK_MODEL = process.env.OPENAI_FALLBACK_MODEL || REGULAR_MODEL;
const isDeepRun = process.env.NOMAD17_RESEARCH_DEPTH === "deep" && Boolean(String(process.env.NOMAD17_MISSION || "").trim());

globalThis.fetch = async function nomadFetch(input, init = {}) {
  const url = typeof input === "string" ? input : input?.url || "";
  if (!url.includes("/chat/completions") || !init?.body) return nativeFetch(input, init);

  let body;
  try { body = JSON.parse(init.body); }
  catch { return nativeFetch(input, init); }

  const originalModel = String(body?.model || "");
  if (originalModel !== "stealth/ox-alpha") return nativeFetch(input, init);

  if (!isDeepRun) {
    const regularBody = { ...body, model: REGULAR_MODEL, max_tokens: 3200, temperature: 0.2 };
    delete regularBody.reasoning;
    delete regularBody.reasoning_effort;
    console.log(`[router] regular cycle -> ${REGULAR_MODEL}`);
    return nativeFetch(input, { ...init, body: JSON.stringify(regularBody) });
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
    max_tokens: 7000,
    temperature: 0.2,
  };
  const primaryTimer = setTimeout(() => primaryController.abort(new Error("Ox Alpha deep budget exceeded")), 90000);
  const started = Date.now();
  try {
    console.log("[router] deep primary stealth/ox-alpha full-valid-json budget=90s");
    const response = await nativeFetch(input, { ...init, signal: primaryController.signal, body: JSON.stringify(primaryBody) });
    const raw = await response.text();
    console.log(`[router] deep primary complete status=${response.status} bytes=${raw.length} in ${Date.now() - started}ms`);
    let envelope = null;
    try { envelope = raw ? JSON.parse(raw) : null; } catch {}
    const content = envelope?.choices?.[0]?.message?.content;
    let parsed = null;
    if (typeof content === "string" && content.trim()) try { parsed = JSON.parse(content); } catch {}
    if (response.ok && parsed && typeof parsed === "object") {
      return new Response(raw, { status: response.status, statusText: response.statusText, headers: response.headers });
    }
    if (!response.ok && response.status < 500 && response.status !== 429) {
      return new Response(raw, { status: response.status, statusText: response.statusText, headers: response.headers });
    }
    console.warn(`[router] deep Ox Alpha unusable; falling back to ${FALLBACK_MODEL}`);
  } catch (error) {
    if (callerSignal?.aborted) throw error;
    console.warn(`[router] deep Ox Alpha failed after ${Date.now() - started}ms: ${error?.message || error}`);
  } finally {
    clearTimeout(primaryTimer);
    if (callerSignal) callerSignal.removeEventListener("abort", onCallerAbort);
  }

  const fallbackBody = { ...body, model: FALLBACK_MODEL, max_tokens: 5000, temperature: 0.2 };
  delete fallbackBody.reasoning;
  delete fallbackBody.reasoning_effort;
  console.log(`[router] deep fallback -> ${FALLBACK_MODEL}`);
  return nativeFetch(input, { ...init, signal: callerSignal, body: JSON.stringify(fallbackBody) });
};

let exitCode = 0;
try {
  console.log(`[run-once] configured=${process.env.OPENAI_MODEL || "unset"} regular=${REGULAR_MODEL} deep=${isDeepRun}`);
  const { runCycle } = await import("./src/agent.js");
  const result = await runCycle({ reason: process.env.GITHUB_ACTIONS ? "github-actions" : "manual" });
  console.log(JSON.stringify(result, null, 2));
} catch (err) {
  exitCode = 1;
  console.error(err?.stack || err?.message || String(err));
}

console.log(`[run-once] exiting code=${exitCode}`);
process.exit(exitCode);
