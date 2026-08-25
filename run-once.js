const nativeFetch = globalThis.fetch.bind(globalThis);

const PRIMARY_MODEL = "stealth/ox-alpha";
const FALLBACK_MODELS = (process.env.OPENAI_FALLBACK_MODELS || "")
  .split(",").map(x => x.trim()).filter(Boolean);
const isDeepRun = process.env.NOMAD17_RESEARCH_DEPTH === "deep" && Boolean(String(process.env.NOMAD17_MISSION || "").trim());

function parseJsonLoose(text) {
  text = String(text || "").trim();
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

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

// Streams the completion instead of buffering it server-side and returning it in
// one shot. Two reasons: (1) it gives real time-to-first-token / stage timing for
// observability, and (2) measured evidence (2026-08-25 diagnostic) showed the
// non-streaming path to stealth/ox-alpha is the one that stalls past its budget on
// content-heavy real prompts, while an identical streamed request completes and
// simply takes as long as generation genuinely takes. Streaming keeps the
// connection visibly alive instead of looking idle to any intermediate proxy.
async function attemptOnce(input, init, body, model, reasoningEffort, controller, stage) {
  const requestBody = {
    ...body,
    model,
    temperature: 0.2,
    max_tokens: body.max_tokens,
    reasoning: { effort: reasoningEffort, exclude: true },
    stream: true,
  };
  stage("request_start", `prompt_bytes=${JSON.stringify(requestBody.messages || []).length} max_tokens=${requestBody.max_tokens}`);
  const response = await nativeFetch(input, { ...init, signal: controller.signal, body: JSON.stringify(requestBody) });
  stage("headers_received", `status=${response.status} ok=${response.ok}`);

  if (!response.ok || !response.body) {
    const raw = await response.text();
    stage("body_received_error", `bytes=${raw.length} head=${raw.slice(0, 300)}`);
    return { response: null, status: response.status, raw };
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buf = "", content = "", reasoningText = "", finishReason = null, firstByte = false, errPayload = null;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!firstByte) { firstByte = true; stage("first_byte"); }
    buf += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line.startsWith("data:")) continue;
      const payload = line.slice(5).trim();
      if (payload === "[DONE]") continue;
      let evt;
      try { evt = JSON.parse(payload); } catch { continue; }
      if (evt.error) { errPayload = evt.error; continue; }
      const delta = evt?.choices?.[0]?.delta;
      if (typeof delta?.reasoning === "string") reasoningText += delta.reasoning;
      if (typeof delta?.content === "string") content += delta.content;
      if (evt?.choices?.[0]?.finish_reason) finishReason = evt.choices[0].finish_reason;
    }
  }
  stage("body_received", `content_len=${content.length} reasoning_len=${reasoningText.length} finish_reason=${finishReason}${errPayload ? ` stream_error=${JSON.stringify(errPayload).slice(0, 300)}` : ""}`);

  const parsed = parseJsonLoose(content);
  if (!parsed) {
    stage("json_parse_failed", `content_head=${content.slice(0, 200)}`);
    return { response: null, status: response.status, raw: errPayload ? JSON.stringify(errPayload) : `unparsable content (finish_reason=${finishReason}): ${content.slice(0, 500)}` };
  }
  stage("json_parsed");
  const envelope = JSON.stringify({ choices: [{ message: { content: JSON.stringify(parsed) }, finish_reason: finishReason }] });
  return { response: new Response(envelope, { status: response.status, statusText: response.statusText }), status: response.status, raw: null };
}

// "stealth/ox-alpha" is served through OpenRouter's shared, rate-limited pool
// (evidence: 2026-08-25 verification run got a fast, explicit 429
// "temporarily rate-limited upstream... retry shortly" from provider_name
// "Stealth"). That is explicitly transient, so retry a couple of times with a
// short backoff instead of treating it as a hard failure, as long as the
// overall per-model budget allows it.
async function attemptModel(input, init, body, model, timeoutMs, reasoningEffort, relayCallerAbort = true) {
  const callerSignal = init.signal;
  const controller = new AbortController();
  const relayAbort = () => controller.abort(callerSignal?.reason);
  if (callerSignal && relayCallerAbort) {
    if (callerSignal.aborted) controller.abort(callerSignal.reason);
    else callerSignal.addEventListener("abort", relayAbort, { once: true });
  }
  const timer = setTimeout(() => controller.abort(new Error(`${model} budget exceeded (${Math.round(timeoutMs / 1000)}s)`)), timeoutMs);
  const started = Date.now();
  const stage = (label, extra = "") => console.log(`[router:${model}] ${label} at +${Date.now() - started}ms${extra ? ` ${extra}` : ""}`);
  try {
    let attempt = 0, result;
    while (true) {
      attempt++;
      try {
        result = await attemptOnce(input, init, body, model, reasoningEffort, controller, stage);
      } catch (error) {
        if (callerSignal?.aborted && relayCallerAbort) throw error;
        stage("exception", String(error?.message || error));
        result = { response: null, status: 0, raw: String(error?.message || error) };
      }
      if (result.response || result.status !== 429) return result;
      const remaining = timeoutMs - (Date.now() - started);
      const backoffMs = Math.min(5000 * attempt, 15000);
      if (attempt >= 3 || remaining < backoffMs + 5000) { stage("retry_budget_exhausted", `attempt=${attempt} remaining=${remaining}ms`); return result; }
      stage("retry_after_429", `attempt=${attempt} backoff=${backoffMs}ms`);
      await sleep(backoffMs);
    }
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
    isDeepRun ? 150000 : 65000,
    isDeepRun ? "low" : "minimal",
    // Regular agent.js still carries an outer safety-net AbortController. Do not
    // let that pre-empt Ox Alpha before the router's own budget expires.
    isDeepRun
  );
  if (primary?.response) return primary.response;

  // Keep this budget small: the workflow's own bash `timeout 120s` wraps the whole
  // regular cycle, and the primary Ox Alpha attempt above already spends up to 65s.
  // Only configure one or two fallback models, and keep OPENAI_FALLBACK_MODELS
  // short, or the total (primary + fallbacks) can exceed the outer ceilings.
  for (const model of FALLBACK_MODELS) {
    console.warn(`[router] Ox Alpha unavailable; fallback -> ${model} (visible fallback, not silent)`);
    const fallback = await attemptModel(input, init, body, model, 20000, "minimal", true);
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
