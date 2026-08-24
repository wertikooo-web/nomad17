const nativeFetch = globalThis.fetch.bind(globalThis);

const REGULAR_MODELS = (process.env.OPENAI_REGULAR_MODELS || "google/gemma-4-31b-it-20260402:free,google/gemma-4-26b-a4b-it:free,z-ai/glm-5.2:free")
  .split(",").map(x => x.trim()).filter(Boolean);
const DEEP_FALLBACK_MODEL = process.env.OPENAI_FALLBACK_MODEL || REGULAR_MODELS[0];
const isDeepRun = process.env.NOMAD17_RESEARCH_DEPTH === "deep" && Boolean(String(process.env.NOMAD17_MISSION || "").trim());

function parseJsonLoose(value) {
  if (value && typeof value === "object" && !Array.isArray(value)) return value;
  let text = "";
  if (typeof value === "string") text = value.trim();
  else if (Array.isArray(value)) text = value.map(x => typeof x === "string" ? x : (x?.text || x?.content || "")).join("").trim();
  if (!text) return null;
  const candidates = [text];
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence?.[1]) candidates.push(fence[1].trim());
  const first = text.indexOf("{"), last = text.lastIndexOf("}");
  if (first >= 0 && last > first) candidates.push(text.slice(first, last + 1));
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
    } catch {}
  }
  return null;
}

function normalizeEnvelope(raw) {
  let envelope = null;
  try { envelope = raw ? JSON.parse(raw) : null; } catch { return null; }
  const message = envelope?.choices?.[0]?.message;
  if (!message) return null;
  const parsed = parseJsonLoose(message.content);
  if (!parsed) return null;
  message.content = JSON.stringify(parsed);
  return JSON.stringify(envelope);
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
    const requestBody = { ...body, model, temperature: 0.2, reasoning: { effort: "minimal", exclude: true } };
    const response = await nativeFetch(input, { ...init, signal: controller.signal, body: JSON.stringify(requestBody) });
    const raw = await response.text();
    const normalized = response.ok ? normalizeEnvelope(raw) : null;
    let detail = "";
    if (!normalized && response.ok) {
      try {
        const env = JSON.parse(raw);
        const msg = env?.choices?.[0]?.message;
        detail = ` finish=${env?.choices?.[0]?.finish_reason ?? "?"} content_type=${Array.isArray(msg?.content) ? "array" : typeof msg?.content} content_len=${typeof msg?.content === "string" ? msg.content.length : 0} reasoning_len=${typeof msg?.reasoning === "string" ? msg.reasoning.length : 0}`;
      } catch {}
    }
    console.log(`[router] ${model} status=${response.status} bytes=${raw.length} normalized=${Boolean(normalized)} elapsed=${Date.now() - started}ms${detail}`);
    if (normalized) return new Response(normalized, { status: response.status, statusText: response.statusText, headers: response.headers });
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

  if (String(body?.model || "") !== "stealth/ox-alpha") return nativeFetch(input, init);

  if (!isDeepRun) {
    for (const model of REGULAR_MODELS) {
      console.log(`[router] regular attempt -> ${model}`);
      const response = await attemptModel(input, init, { ...body, max_tokens: 4000 }, model, 20000);
      if (response) return response;
    }
    throw new Error(`No regular OpenRouter model produced usable structured JSON: ${REGULAR_MODELS.join(", ")}`);
  }

  const callerSignal = init.signal;
  const primaryController = new AbortController();
  const relayAbort = () => primaryController.abort(callerSignal?.reason);
  if (callerSignal) {
    if (callerSignal.aborted) primaryController.abort(callerSignal.reason);
    else callerSignal.addEventListener("abort", relayAbort, { once: true });
  }
  const timer = setTimeout(() => primaryController.abort(new Error("Ox Alpha deep budget exceeded")), 90000);
  const started = Date.now();
  try {
    const primaryBody = { ...body, model: "stealth/ox-alpha", reasoning: { effort: "low", exclude: true }, max_tokens: 7000, temperature: 0.2 };
    const response = await nativeFetch(input, { ...init, signal: primaryController.signal, body: JSON.stringify(primaryBody) });
    const raw = await response.text();
    const normalized = response.ok ? normalizeEnvelope(raw) : null;
    console.log(`[router] deep Ox Alpha status=${response.status} bytes=${raw.length} normalized=${Boolean(normalized)} elapsed=${Date.now() - started}ms`);
    if (normalized) return new Response(normalized, { status: response.status, statusText: response.statusText, headers: response.headers });
  } catch (error) {
    if (callerSignal?.aborted) throw error;
    console.warn(`[router] deep Ox Alpha failed after ${Date.now() - started}ms: ${error?.message || error}`);
  } finally {
    clearTimeout(timer);
    if (callerSignal) callerSignal.removeEventListener("abort", relayAbort);
  }

  const fallback = await attemptModel(input, init, { ...body, max_tokens: 5000 }, DEEP_FALLBACK_MODEL, 45000);
  if (fallback) return fallback;
  throw new Error(`Deep fallback ${DEEP_FALLBACK_MODEL} did not produce usable JSON`);
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
