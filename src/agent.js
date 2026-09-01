import * as f916 from "./f916.js";
import {
  getState,
  saveState,
  getMemory,
  saveMemory,
  audit,
  loadSecret,
  appendJournal,
} from "./memory.js";
import { SYSTEM_POLICY, allowAction, safeMode, LIMITS } from "./policy.js";

function compact(value, max = 12000) {
  const s = JSON.stringify(value);
  return s.length > max ? s.slice(0, max) + "…[truncated]" : s;
}

async function llm(messages, { deep = false } = {}) {
  const key = process.env.OPENAI_API_KEY;
  const model = process.env.OPENAI_MODEL;
  const base = (process.env.OPENAI_BASE_URL || "https://api.openai.com/v1").replace(/\/$/, "");
  if (!key || !model) throw new Error("OPENAI_API_KEY and OPENAI_MODEL are required");

  // This is a dead-man's switch only. The real timing/retry/fallback logic lives
  // in run-once.js's router (attemptModel), which owns its own budget per model
  // and is the source of truth for what actually happened. This outer timer exists
  // solely so a bug in the router can't hang the process forever; it is set well
  // above the router's own worst-case total so it should, in normal operation,
  // never fire first. If it does fire, that fact is reported honestly below
  // instead of being conflated with the router's own (more specific) errors.
  // Worst case for a regular run is primary (90s) + one 20s fallback attempt =
  // 110s. Only configure ONE fallback model in OPENAI_FALLBACK_MODELS for regular
  // cycles — two would risk exceeding the workflow's outer `timeout 120s`, which
  // is a hard OS-level kill this in-process switch cannot prevent. This number is
  // set just under that 120s ceiling so the process gets a chance to log an honest
  // error before bash would SIGKILL it anyway. Deep runs: primary (480s) + one 20s
  // fallback = 500s, comfortably inside the 600s bash ceiling for deep missions.
  const controller = new AbortController();
  const outerBudgetMs = deep ? 560000 : 115000;
  let outerTimedOut = false;
  const timer = setTimeout(() => { outerTimedOut = true; controller.abort(); }, outerBudgetMs);
  const started = Date.now();
  console.log(`[LLM] start model=${model} deep=${deep} outer_safety_budget=${Math.round(outerBudgetMs / 1000)}s`);
  try {
    const response = await fetch(`${base}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      signal: controller.signal,
      body: JSON.stringify({
        model,
        temperature: 0.38,
        // minimax/minimax-m2.7:free needs more headroom than the paid model did to
        // finish the same schemas without getting cut off mid-JSON (verified
        // regular failure: run 33317721589, finish_reason=length at 3500).
        // Deep mode's 10-candidate + mission_report schema needed even more:
        // verified failure run 33318812494 still hit finish_reason=length at
        // 9000, only partway through the first of up to 10 candidates. The
        // model's real ceiling (openrouter.ai/api/v1/models, 2026-08-30) is
        // 176947 completion tokens, so 9000 was never close to its actual
        // limit — it just needs telling. It stops on its own (finish_reason=
        // stop) once the JSON is complete, so a big ceiling here doesn't force
        // it to ramble; it only removes the premature cutoff.
        max_tokens: deep ? 30000 : 7000,
        response_format: { type: "json_object" },
        messages,
      }),
    });
    const raw = await response.text();
    console.log(`[LLM] response status=${response.status} bytes=${raw.length} elapsed=${Date.now() - started}ms`);
    let data;
    try { data = raw ? JSON.parse(raw) : {}; }
    catch { throw new Error(`LLM returned invalid JSON envelope after ${Date.now() - started}ms`); }
    if (!response.ok) throw new Error(`LLM ${response.status}: ${compact(data, 2000)}`);
    const content = data?.choices?.[0]?.message?.content;
    if (!content) throw new Error(`LLM returned no message content (${model})`);
    try { return JSON.parse(content); }
    catch { throw new Error(`LLM message was not valid JSON (${model})`); }
  } catch (error) {
    if (outerTimedOut) throw new Error(`LLM outer safety timeout after ${Math.round(outerBudgetMs / 1000)}s (${model}) — the router should have failed faster than this; this is a fallback circuit breaker firing`);
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function candidatesFromChanges(data) {
  if (!data) return [];
  const out = [];
  for (const key of ["posts", "comments", "changes", "items", "events"]) if (Array.isArray(data[key])) out.push(...data[key]);
  return out.slice(0, 100);
}
function firstText(obj, keys) { for (const key of keys) if (typeof obj?.[key] === "string" && obj[key].trim()) return obj[key].trim(); return ""; }
function sourceView(item = {}) {
  const id = item.id ?? item.post_id ?? item.comment_id ?? null;
  const type = item.type || (item.comment_id ? "comment" : "post");
  const title = firstText(item, ["title", "subject", "name"]) || (id ? `1F916 ${type} #${id}` : "1F916 item");
  const author = firstText(item, ["handle", "author_handle", "author", "user", "agent"]);
  const source_text = firstText(item, ["body", "text", "content", "message", "summary"]).slice(0, 4000);
  const post_id = item.post_id || (type === "post" ? id : null);
  return { id, type, title, author, source_text, post_id, url: post_id ? `https://1f916.ai/api/post/${post_id}` : null };
}
function sameId(item, pick) { const ids = [item?.id, item?.post_id, item?.comment_id].filter(v => v != null).map(String); return ids.includes(String(pick?.id)) || (pick?.post_id && ids.includes(String(pick.post_id))); }
function collectInbox(value, out = [], depth = 0) {
  if (depth > 5 || value == null) return out;
  if (Array.isArray(value)) { for (const x of value) collectInbox(x, out, depth + 1); return out; }
  if (typeof value !== "object") return out;
  const text = firstText(value, ["body", "text", "content", "message"]);
  if (text && (value.id != null || value.comment_id != null || value.post_id != null)) out.push(sourceView(value));
  for (const [key, x] of Object.entries(value)) if (!["secret", "token", "key", "credential"].includes(key.toLowerCase())) collectInbox(x, out, depth + 1);
  return out;
}
function uniq(items) { const seen = new Set(); return items.filter(x => { const key = `${x.type}:${x.id}:${x.post_id}:${x.source_text}`; if (seen.has(key)) return false; seen.add(key); return true; }); }
function translated(list, item, key) { const found = Array.isArray(list) ? list.find(x => sameId(item, x)) : null; return flattenRu(found?.[key] || "").slice(0, 4000); }
function simpleList(source, key, fallback) { return Array.isArray(source?.[key]) ? source[key].slice(0, 5) : (fallback || []).slice(0, 5); }
function cleanText(value) { if (typeof value === "string") return value; if (value && typeof value === "object") return String(value.text || value.claim || value.question || value.lesson || value.topic || JSON.stringify(value)); return String(value ?? ""); }
// The model is asked for a single labeled string (e.g. "Что произошло: ... Почему
// это интересно: ..."), but sometimes returns a nested object with those labels as
// keys instead. Rendering that with String() produces the literal text
// "[object Object]" on the dashboard. Flatten it into readable text instead.
function flattenRu(value) {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(flattenRu).filter(Boolean).join(" ");
  if (value && typeof value === "object") return Object.entries(value).map(([k, v]) => `${k}: ${flattenRu(v)}`).join(" ");
  return String(value ?? "");
}
function clamp(value, min, max) { return Math.max(min, Math.min(max, Number(value) || 0)); }

function applySocialMemory(memory, update, now) {
  if (Array.isArray(update.interests)) {
    const map = new Map((memory.interests || []).map(x => [String(x.topic || x.name || x.text).toLowerCase(), x]));
    for (const item of update.interests.slice(0, 8)) {
      const topic = cleanText(item.topic || item.name || item.text).slice(0, 120); if (!topic) continue;
      const key = topic.toLowerCase(), old = map.get(key) || {};
      map.set(key, { topic, strength: clamp(item.strength ?? old.strength ?? 0.5, 0, 1), why: cleanText(item.why || old.why).slice(0, 500), updated_at: now });
    }
    memory.interests = [...map.values()].sort((a, b) => (b.strength || 0) - (a.strength || 0)).slice(0, 20);
  }
  if (Array.isArray(update.open_loops)) {
    const map = new Map((memory.open_loops || []).map(x => [String(x.id || x.question), x]));
    for (const item of update.open_loops.slice(0, 10)) {
      const question = cleanText(item.question || item.text).slice(0, 500); if (!question) continue;
      const id = String(item.id || question.toLowerCase().slice(0, 80));
      map.set(id, { ...(map.get(id) || {}), id, question, status: ["open", "resolved", "waiting"].includes(item.status) ? item.status : "open", priority: clamp(item.priority ?? 0.5, 0, 1), related_agents: Array.isArray(item.related_agents) ? item.related_agents.slice(0, 8) : [], updated_at: now });
    }
    memory.open_loops = [...map.values()].filter(x => x.status !== "resolved").sort((a, b) => (b.priority || 0) - (a.priority || 0)).slice(0, 30);
  }
  if (Array.isArray(update.relationships)) for (const item of update.relationships.slice(0, 12)) {
    const handle = cleanText(item.handle).replace(/^@/, "").slice(0, 100); if (!handle) continue;
    const old = memory.relationships[handle] || {};
    memory.relationships[handle] = { handle, familiarity: clamp(item.familiarity ?? old.familiarity ?? 0.2, 0, 1), trust: clamp(item.trust ?? old.trust ?? 0.5, 0, 1), topics: [...new Set([...(old.topics || []), ...(Array.isArray(item.topics) ? item.topics : [])])].slice(-12), last_interaction: now, notes: cleanText(item.notes || old.notes).slice(0, 700) };
  }
  if (update.curiosity_event) { memory.curiosity_log.push({ at: now, text: cleanText(update.curiosity_event).slice(0, 700) }); memory.curiosity_log = memory.curiosity_log.slice(-100); }
}

export async function runCycle({ reason = "manual" } = {}) {
  const state = await getState(), memory = await getMemory();
  state.mode = safeMode(process.env.AGENT_MODE || state.mode);
  const secret = await loadSecret();
  const mission = String(process.env.NOMAD17_MISSION || "").trim().slice(0, 1500);
  const deep = Boolean(mission && process.env.NOMAD17_RESEARCH_DEPTH === "deep");
  const summary = { reason, mode: state.mode, started: new Date().toISOString(), mission: mission || null, actions: [], notes: [] };
  try {
    const pulse = await f916.pulse(secret || undefined); state.lastPulse = pulse;
    let changeData = null;
    try { const ch = await f916.changes(state.lastSince || 0, state.etag || null); if (ch.status !== 304) { changeData = ch.data; if (ch.etag) state.etag = ch.etag; if (ch.data?.next_since) state.lastSince = ch.data.next_since; } } catch (e) { summary.notes.push(`changes unavailable: ${e.message}`); }
    let inbox = null; if (secret) try { inbox = await f916.me(secret, state.lastSince || 0); } catch (e) { summary.notes.push(`inbox unavailable: ${e.message}`); }
    const incoming = uniq(collectInbox(inbox)).slice(0, deep ? 20 : 8);
    let pool = candidatesFromChanges(changeData);
    try { const front = await f916.front(); if (Array.isArray(front)) pool.push(...front); else if (Array.isArray(front?.posts)) pool.push(...front.posts); } catch (e) { summary.notes.push(`front unavailable: ${e.message}`); }
    const corpusLimit = deep ? 100 : 20; pool = uniq(pool.map(sourceView)).slice(0, corpusLimit);
    summary.notes.push(`corpus budget: ${pool.length}/${corpusLimit}; inbox: ${incoming.length}/${deep ? 20 : 8}`);

    // Regular (non-deep) cycles intentionally ask for a much lighter output than
    // deep/mission runs. Measured evidence (2026-08-25 diagnostic against real
    // 1F916 content) showed the full 4-candidate / 4-part-Russian schema makes
    // stealth/ox-alpha genuinely generate ~15KB of output, taking ~90s — right at
    // the edge of any sane "just wake up" SLA. Cutting candidate count and
    // trimming the Russian schema is the actual fix, not a bigger timeout.
    const maxCandidates = deep ? 10 : 2;
    const socialRule = `You are Nomad17, a continuing field researcher with social history. Durable memory contains INTERESTS, RELATIONSHIPS and OPEN_LOOPS. Prefer continuity when evidence advances an old question. Do not reply merely to be social. Silence is valid. Keep some serendipity. Return social_memory_update {interests:[{topic,strength,why}],open_loops:[{id?,question,status:"open"|"waiting"|"resolved",priority,related_agents:[]}],relationships:[{handle,familiarity,trust,topics:[],notes}],curiosity_event}. Also return selection_notes_simple_ru in 1-3 clear Russian sentences.`;
    // "simple_ru MUST be one plain string" is stated explicitly and repeated,
    // because earlier wording ("simple_ru MUST contain N labeled parts") led the
    // model to sometimes return a nested {label: text} JSON object instead of a
    // single string with those labels inline — which rendered as the literal
    // text "[object Object]" on the dashboard.
    const plainRussianRule = deep
      ? `The SIMPLE Russian view is written for a curious non-technical human. simple_ru MUST be one plain string (never a JSON object). For every selected item, that string must contain four short labeled parts in this exact order, concatenated as plain text: "Что произошло:", "Почему мне стало интересно:", "Что это значит:", "Зачем это может пригодиться:". Explain concrete events first, then meaning. Decode blockchain, AI, governance, finance and platform jargon in ordinary Russian. Avoid calques and bureaucratic phrases such as "он-чейн чек", "финансовые потоки", "примитив", "казённый адрес", "агентная экосистема" unless you immediately explain them in everyday words. Do not merely translate the source. reason_ru is a faithful translation of reason (same technical terms); reason_simple_ru is a DIFFERENT plain-language one-sentence rewrite of it, not a reworded reason_ru — answering why Nomad17 personally noticed it, in plain words. topic_ru must be a plain string, a human headline, not a taxonomy label. The Russian text should be understandable without reading the English original.`
      : `The SIMPLE Russian view is written for a curious non-technical human. simple_ru MUST be one plain string (never a JSON object). For every selected item, that string must contain two short labeled parts in this exact order, concatenated as plain text: "Что произошло:", "Почему это интересно:". Keep each part to one short sentence. Decode blockchain, AI, governance, finance and platform jargon in ordinary Russian instead of calquing it. Do not merely translate the source. reason_ru is a faithful translation of reason (same technical terms); reason_simple_ru is a DIFFERENT plain-language one-sentence rewrite of it, not a reworded reason_ru. topic_ru must be a plain string, a human headline, not a taxonomy label. Be concise — this is a quick wake-up cycle, not a deep report.`;
    const researchRule = deep ? `Mission: ${mission}. Do evidence-based field research. Use multiple authors/threads, separate observation from inference, seek disagreement, never invent consensus. Return mission_report {mission,status:"complete"|"partial",answer_simple_ru,key_findings:[{claim,evidence_ids:[id],confidence}],counterpoints:[{point,evidence_ids:[id]}],evidence:[{id,post_id?,author,quote_or_paraphrase}],what_is_uncertain:[],next_questions:[],quality:{distinct_sources,distinct_agents,confidence}}.` : "";
    // reason is Nomad17's own English note-to-self on why it picked something;
    // reason_ru is a faithful translation of it, reason_simple_ru is a plain-
    // language rewrite — same three-way split as everything else, so the
    // "Почему заметил" line actually changes with the view toggle instead of
    // showing English under both "Русский" and "Просто".
    const candidateFields = `{id,post_id?,type,score,topic_ru,reason,reason_ru,reason_simple_ru,ru_translation,simple_ru,proposed_action:"none"|"vote"|"tag"|"comment",tag?,comment?,comment_ru?,comment_simple_ru?}`;
    const memoryUpdateFields = deep ? `memory_update {observations:[],hypotheses:[],questions:[],lessons:[]}, memory_update_simple with same keys, ` : `memory_update {observations:[],hypotheses:[],questions:[],lessons:[]}, `;
    console.log(`[stage] prompt build: mode=${state.mode} deep=${deep} candidates<=${maxCandidates} pool=${pool.length} incoming=${incoming.length}`);
    const decision = await llm([
      { role: "system", content: SYSTEM_POLICY },
      { role: "system", content: `Current mode: ${state.mode}. Return strict JSON. ${socialRule} ${plainRussianRule} ${researchRule} ru_translation must be one plain string (never a JSON object), fluent Russian, preserving factual detail.` },
      { role: "user", content: `DURABLE MEMORY:\n${compact(memory, deep ? 11000 : 4500)}\nINBOX:\n${compact(incoming, deep ? 8000 : 3000)}\nPUBLIC CORPUS:\n${compact(pool, deep ? 24000 : 8000)}\nChoose at most ${maxCandidates} useful candidates (fewer is fine, silence is valid). Return candidates [${candidateFields}], inbox_translations [{id,post_id?,type,topic_ru,ru_translation,simple_ru}], ${memoryUpdateFields}daily_takeaways [{kind:"idea"|"strange"|"conversation",title,text,title_ru,text_ru,text_simple_ru,evidence_ids:[id]}] (title/text in English, never mixing in Russian words. title_ru/text_ru are a faithful Russian translation, same technical terms. text_simple_ru is a DIFFERENT plain-language rewrite for a curious non-technical human — decode the jargon into ordinary Russian instead of translating it, explain what happened and why it matters, do not just restate text_ru in other words), social_memory_update, selection_notes_simple_ru. ${deep ? "Also mission_report." : ""}` },
    ], { deep });

    const picks = Array.isArray(decision.candidates) ? decision.candidates.slice(0, maxCandidates) : [];
    // pool/incoming entries are already sourceView()-shaped (source_text, not
    // body/text/content), so re-running sourceView() on them here used to look
    // for the wrong field names and silently wipe source_text — that was the
    // "Original" tab showing blank source text on the dashboard.
    const reads = picks.map(pick => { const raw = pool.find(x => sameId(x, pick)) || incoming.find(x => sameId(x, pick)) || {}; return { ...raw, id: pick.id ?? raw.id, type: pick.type || raw.type, topic_ru: flattenRu(pick.topic_ru || "").slice(0, 100), ru_translation: flattenRu(pick.ru_translation || "").slice(0, 4000), simple_ru: flattenRu(pick.simple_ru || "").slice(0, 4000), reason: flattenRu(pick.reason || "").slice(0, 1000), reason_ru: flattenRu(pick.reason_ru || "").slice(0, 1200), reason_simple_ru: flattenRu(pick.reason_simple_ru || "").slice(0, 1200) }; });
    const counts = { comment: 0, vote: 0, tag: 0, post: 0 }, conversations = [], inboxTranslations = decision.inbox_translations || [];
    for (const item of incoming) conversations.push({ direction: "in", ...item, topic_ru: translated(inboxTranslations, item, "topic_ru").slice(0, 100), ru_translation: translated(inboxTranslations, item, "ru_translation"), simple_ru: translated(inboxTranslations, item, "simple_ru") });
    for (const pick of picks) {
      const score = Number(pick.score || 0), action = pick.proposed_action || "none";
      if (action === "none" || !allowAction(state.mode, action, score) || counts[action] >= LIMITS[action + "s"] || !secret) continue;
      try {
        if (action === "vote") { await f916.vote(secret, pick.type || "post", Number(pick.id)); counts.vote++; summary.actions.push({ action, id: pick.id, reason: pick.reason }); }
        else if (action === "tag" && pick.type === "post" && pick.tag) { await f916.tag(secret, Number(pick.id), String(pick.tag).slice(0, 40)); counts.tag++; summary.actions.push({ action, id: pick.id, reason: pick.reason }); }
        else if (action === "comment" && pick.comment && counts.comment < 2) {
          const postId = Number(pick.post_id || pick.id), text = String(pick.comment).slice(0, 1600), result = await f916.comment(secret, postId, text, null); counts.comment++;
          summary.actions.push({ action, id: postId, reason: pick.reason, text });
          conversations.push({ direction: "out", type: "comment", id: result?.id ?? result?.comment_id ?? null, post_id: postId, author: "nomad17", topic_ru: flattenRu(pick.topic_ru || "").slice(0, 100), source_text: text, ru_translation: flattenRu(pick.comment_ru || "").slice(0, 3000), simple_ru: flattenRu(pick.comment_simple_ru || pick.comment_ru || "").slice(0, 3000) });
        }
      } catch (e) { summary.notes.push(`${action} failed for ${pick.id}: ${e.message}`); }
    }
    console.log(`[stage] actions: picks=${picks.length} reads=${reads.length} comment=${counts.comment} vote=${counts.vote} tag=${counts.tag}`);
    const memoryUpdate = decision.memory_update || {}, simpleUpdate = decision.memory_update_simple || {}, now = new Date().toISOString();
    for (const key of ["observations", "hypotheses", "questions", "lessons"]) {
      if (!Array.isArray(memoryUpdate[key])) continue;
      for (const value of memoryUpdate[key].slice(0, 5)) { const text = cleanText(value).slice(0, 1000); if (text && text !== "[object Object]") memory[key].push({ at: now, text }); }
      if (memory[key].length > 200) memory[key] = memory[key].slice(-200);
    }
    applySocialMemory(memory, decision.social_memory_update || {}, now);
    state.lastRun = now;
    console.log("[stage] saveMemory start"); await saveMemory(memory); console.log("[stage] saveMemory done");
    console.log("[stage] saveState start"); await saveState(state); console.log("[stage] saveState done");
    await audit({ type: "cycle", summary });
    console.log("[stage] appendJournal start");
    await appendJournal({ at: now, mode: state.mode, citizens: pulse?.board?.citizens ?? null, label: mission ? `Миссия: ${mission.slice(0, 100)}` : (reads.length ? `Прогулка: ${reads.length} интересных находок` : "Тихий цикл"), mission: mission || null, mission_report: decision.mission_report || null, daily_takeaways: (decision.daily_takeaways || []).slice(0, 3), selection_notes_simple_ru: String(decision.selection_notes_simple_ru || "").slice(0, 1200), interests_snapshot: (memory.interests || []).slice(0, 8), open_loops_snapshot: (memory.open_loops || []).slice(0, 8), relationships_snapshot: Object.values(memory.relationships || {}).sort((a, b) => (b.familiarity || 0) - (a.familiarity || 0)).slice(0, 8), reads, hypotheses: (memoryUpdate.hypotheses || []).slice(0, 5).map(cleanText), questions: (memoryUpdate.questions || []).slice(0, 5).map(cleanText), lessons: (memoryUpdate.lessons || []).slice(0, 5).map(cleanText), hypotheses_simple: simpleList(simpleUpdate, "hypotheses", memoryUpdate.hypotheses).map(cleanText), questions_simple: simpleList(simpleUpdate, "questions", memoryUpdate.questions).map(cleanText), lessons_simple: simpleList(simpleUpdate, "lessons", memoryUpdate.lessons).map(cleanText), actions: summary.actions, conversations });
    console.log("[stage] appendJournal done");
    return summary;
  } catch (e) { summary.error = e.message; state.lastRun = new Date().toISOString(); await saveState(state); await audit({ type: "cycle_error", summary }); throw e; }
}
