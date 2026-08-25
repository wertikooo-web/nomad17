const nativeFetch = globalThis.fetch.bind(globalThis);

const PRIMARY_MODEL = "stealth/ox-alpha";
const FALLBACK_MODELS = (process.env.OPENAI_FALLBACK_MODELS || "")
  .split(",").map(x => x.trim()).filter(Boolean);
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

async function attemptModel(input, init, body, model, timeoutMs, reasoningEffort, relayCallerAbort = true) {
  const callerSignal = init.signal;
  const controller = new AbortController();
  const relayAbort = () => controller.abort(callerSignal?.reason);
  if (callerSignal && relayCallerAbort) {
    if (callerSignal.aborted) controller.abort(callerSignal.reason);
    else callerSignal.addEventListener("abort", relayAbort, { once: true });
  }
  const timer = setTimeout(() => controller.abort(new Error(`${model} budget exceeded`)), timeoutMs);
  const started = Date.now();
  try {
    const requestBody = {
      ...body,
      model,
      temperature: 0.2,
      max_tokens: isDeepRun ? 9000 : 6000,
      reasoning: { effort: reasoningEffort, exclude: true }
    };
    const response = await nativeFetch(input, { ...init, signal: controller.signal, body: JSON.stringify(requestBody) });
    const raw = await response.text();
    const normalized = response.ok ? normalizeEnvelope(raw) : null;
    let detail = "";
    try {
      const env = raw ? JSON.parse(raw) : null;
      const msg = env?.choices?.[0]?.message;
      const apiError = env?.error?.message || env?.error?.code || "";
      detail = ` finish=${env?.choices?.[0]?.finish_reason ?? "?"} content_len=${typeof msg?.content === "string" ? msg.content.length : 0} reasoning_len=${typeof msg?.reasoning === "string" ? msg.reasoning.length : 0}${apiError ? ` api_error=${String(apiError).slice(0,300)}` : ""}`;
    } catch {}
    console.log(`[router] ${model} status=${response.status} bytes=${raw.length} normalized=${Boolean(normalized)} elapsed=${Date.now() - started}ms${detail}`);
    if (normalized) return new Response(normalized, { status: response.status, statusText: response.statusText, headers: response.headers });
    return { response: null, status: response.status, raw };
  } catch (error) {
    if (callerSignal?.aborted && relayCallerAbort) throw error;
    console.warn(`[router] ${model} failed after ${Date.now() - started}ms: ${error?.message || error}`);
    return { response: null, status: 0, raw: String(error?.message || error) };
  } finally {
    clearTimeout(timer);
    if (callerSignal && relayCallerAbort) callerSignal.removeEventListener("abort", relayAbort);
  }
}

globalThis.fetch = async function nomadFetch(input, init = {}) {
  const url = typeof input === "string" ? input : input?.url || "";
  if (!url.includes("/chat/completions") || !init?.body) return nativeFetch(input, init);

  let body;
  try { body = JSON.parse(init.body); }
  catch { return nativeFetch(input, init); }

  console.log(`[router] primary -> ${PRIMARY_MODEL} (${isDeepRun ? "deep" : "regular"})`);
  const primary = await attemptModel(
    input,
    init,
    body,
    PRIMARY_MODEL,
    isDeepRun ? 100000 : 85000,
    isDeepRun ? "low" : "minimal",
    // Regular agent.js still has a legacy 70s AbortController. Do not let that
    // kill Ox Alpha before the router's intentional 85s model budget expires.
    isDeepRun
  );
  if (primary?.response) return primary.response;

  for (const model of FALLBACK_MODELS) {
    console.warn(`[router] Ox Alpha unavailable; fallback -> ${model}`);
    const fallback = await attemptModel(input, init, body, model, 30000, "minimal", true);
    if (fallback?.response) return fallback.response;
  }

  const status = primary?.status || "network/timeout";
  const detail = String(primary?.raw || "").slice(0, 500);
  throw new Error(`Ox Alpha did not produce usable structured JSON. status=${status}${detail ? ` detail=${detail}` : ""}`);
};

let exitCode = 0;
try {
  console.log(`[run-once] primary=${PRIMARY_MODEL} configured=${process.env.OPENAI_MODEL || "unset"} deep=${isDeepRun} fallback=${FALLBACK_MODELS.join(" -> ") || "disabled"}`);
  const { runCycle } = await import("./src/agent.js");
  const result = await runCycle({ reason: process.env.GITHUB_ACTIONS ? "github-actions" : "manual" });
  console.log(JSON.stringify(result, null, 2));
} catch (err) {
  exitCode = 1;
  console.error(err?.stack || err?.message || String(err));
}
console.log(`[run-once] exiting code=${exitCode}`);
process.exit(exitCode);
