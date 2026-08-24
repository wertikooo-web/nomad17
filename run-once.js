const nativeFetch = globalThis.fetch.bind(globalThis);

const REGULAR_MODELS = (process.env.OPENAI_REGULAR_MODELS || "google/gemma-4-26b-a4b-it:free,z-ai/glm-5.2:free,nex-agi/nex-n2-pro:free")
  .split(",").map(x => x.trim()).filter(Boolean);
const DEEP_FALLBACK_MODEL = process.env.OPENAI_FALLBACK_MODEL || REGULAR_MODELS[0];
const isDeepRun = process.env.NOMAD17_RESEARCH_DEPTH === "deep" && Boolean(String(process.env.NOMAD17_MISSION || "").trim());

function validEnvelope(raw) {
  let envelope = null;
  try { envelope = raw ? JSON.parse(raw) : null; } catch { return false; }
  const content = envelope?.choices?.[0]?.message?.content;
  if (typeof content !== "string" || !content.trim()) return false;
  try { return Boolean(JSON.parse(content) && typeof JSON.parse(content) === "object"); }
  catch { return false; }
}

async function attemptModel(input, init, body, model, timeoutMs) {
  const callerSignal = init.signal;
  const controller = new AbortController();
  const relayAbort = () => controller.abort(callerSignal?.reason);
  if (callerSignal) {
    if (callerSignal.aborted) controller.abort(callerSignal.reason);
    else callerSignal.addEventListener("abort", relayAbort, { once: true });
  }
  const timer = setTimeout(() => controller.abort(new Error(`${model} budget exceeded`)), timeoutMs);
  const started = Date.now();
  try {
    const requestBody = { ...body, model, temperature: 0.2 };
    delete requestBody.reasoning;
    delete requestBody.reasoning_effort;
    const response = await nativeFetch(input, { ...init, signal: controller.signal, body: JSON.stringify(requestBody) });
    const raw = await response.text();
    const good = response.ok && validEnvelope(raw);
    console.log(`[router] ${model} status=${response.status} bytes=${raw.length} valid_json=${good} elapsed=${Date.now() - started}ms`);
    if (good) return new Response(raw, { status: response.status, statusText: response.statusText, headers: response.headers });
    return null;
  } catch (error) {
    if (callerSignal?.aborted) throw error;
    console.warn(`[router] ${model} failed after ${Date.now() - started}ms: ${error?.message || error}`);
    return null;
  } finally {
    clearTimeout(timer);
    if (callerSignal) callerSignal.removeEventListener("abort", relayAbort);
  }
}

globalThis.fetch = async function nomadFetch(input, init = {}) {
  const url = typeof input === "string" ? input : input?.url || "";
  if (!url.includes("/chat/completions") || !init?.body) return nativeFetch(input, init);

  let body;
  try { body = JSON.parse(init.body); }
  catch { return nativeFetch(input, init); }

  const originalModel = String(body?.model || "");
  if (originalModel !== "stealth/ox-alpha") return nativeFetch(input, init);

  if (!isDeepRun) {
    for (const model of REGULAR_MODELS) {
      console.log(`[router] regular attempt -> ${model}`);
      const response = await attemptModel(input, init, { ...body, max_tokens: 3200 }, model, 20000);
      if (response) return response;
    }
    throw new Error(`No regular OpenRouter model produced valid JSON: ${REGULAR_MODELS.join(", ")}`);
  }

  const callerSignal = init.signal;
  const primaryController = new AbortController();
  const relayAbort = () => primaryController.abort(callerSignal?.reason);
  if (callerSignal) {
    if (callerSignal.aborted) primaryController.abort(callerSignal.reason);
    else callerSignal.addEventListener("abort", relayAbort, { once: true });
  }
  const primaryTimer = setTimeout(() => primaryController.abort(new Error("Ox Alpha deep budget exceeded")), 90000);
  const started = Date.now();
  try {
    const primaryBody = { ...body, model: "stealth/ox-alpha", reasoning: { effort: "low", exclude: true }, max_tokens: 7000, temperature: 0.2 };
    console.log("[router] deep primary -> stealth/ox-alpha");
    const response = await nativeFetch(input, { ...init, signal: primaryController.signal, body: JSON.stringify(primaryBody) });
    const raw = await response.text();
    const good = response.ok && validEnvelope(raw);
    console.log(`[router] deep primary status=${response.status} bytes=${raw.length} valid_json=${good} elapsed=${Date.now() - started}ms`);
    if (good) return new Response(raw, { status: response.status, statusText: response.statusText, headers: response.headers });
  } catch (error) {
    if (callerSignal?.aborted) throw error;
    console.warn(`[router] deep Ox Alpha failed after ${Date.now() - started}ms: ${error?.message || error}`);
  } finally {
    clearTimeout(primaryTimer);
    if (callerSignal) callerSignal.removeEventListener("abort", relayAbort);
  }

  console.log(`[router] deep fallback -> ${DEEP_FALLBACK_MODEL}`);
  const fallback = await attemptModel(input, init, { ...body, max_tokens: 5000 }, DEEP_FALLBACK_MODEL, 45000);
  if (fallback) return fallback;
  throw new Error(`Deep fallback ${DEEP_FALLBACK_MODEL} did not produce valid JSON`);
};

let exitCode = 0;
try {
  console.log(`[run-once] configured=${process.env.OPENAI_MODEL || "unset"} regular_chain=${REGULAR_MODELS.join(" -> ")} deep=${isDeepRun}`);
  const { runCycle } = await import("./src/agent.js");
  const result = await runCycle({ reason: process.env.GITHUB_ACTIONS ? "github-actions" : "manual" });
  console.log(JSON.stringify(result, null, 2));
} catch (err) {
  exitCode = 1;
  console.error(err?.stack || err?.message || String(err));
}

console.log(`[run-once] exiting code=${exitCode}`);
process.exit(exitCode);
