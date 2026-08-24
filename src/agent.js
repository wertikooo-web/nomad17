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

async function llm(messages) {
  const key = process.env.OPENAI_API_KEY;
  const model = process.env.OPENAI_MODEL;
  const base = (process.env.OPENAI_BASE_URL || "https://api.openai.com/v1").replace(/\/$/, "");
  if (!key || !model) throw new Error("OPENAI_API_KEY and OPENAI_MODEL are required");

  const response = await fetch(`${base}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model,
      temperature: 0.38,
      response_format: { type: "json_object" },
      messages,
    }),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(`LLM ${response.status}: ${compact(data, 2000)}`);
  return JSON.parse(data.choices[0].message.content);
}

function candidatesFromChanges(data) {
  if (!data) return [];
  const out = [];
  for (const key of ["posts", "comments", "changes", "items", "events"]) {
    if (Array.isArray(data[key])) out.push(...data[key]);
  }
  return out.slice(0, 100);
}

function firstText(obj, keys) {
  for (const key of keys) {
    if (typeof obj?.[key] === "string" && obj[key].trim()) return obj[key].trim();
  }
  return "";
}

function sourceView(item = {}) {
  const id = item.id ?? item.post_id ?? item.comment_id ?? null;
  const type = item.type || (item.comment_id ? "comment" : "post");
  const title = firstText(item, ["title", "subject", "name"]) || (id ? `1F916 ${type} #${id}` : "1F916 item");
  const author = firstText(item, ["handle", "author_handle", "author", "user", "agent"]);
  const source_text = firstText(item, ["body", "text", "content", "message", "summary"]).slice(0, 4000);
  const post_id = item.post_id || (type === "post" ? id : null);
  return { id, type, title, author, source_text, post_id, url: post_id ? `https://1f916.ai/api/post/${post_id}` : null };
}

function sameId(item, pick) {
  const ids = [item?.id, item?.post_id, item?.comment_id].filter(v => v != null).map(String);
  return ids.includes(String(pick?.id)) || (pick?.post_id && ids.includes(String(pick.post_id)));
}

function collectInbox(value, out = [], depth = 0) {
  if (depth > 5 || value == null) return out;
  if (Array.isArray(value)) {
    for (const x of value) collectInbox(x, out, depth + 1);
    return out;
  }
  if (typeof value !== "object") return out;
  const text = firstText(value, ["body", "text", "content", "message"]);
  if (text && (value.id != null || value.comment_id != null || value.post_id != null)) out.push(sourceView(value));
  for (const [key, x] of Object.entries(value)) {
    if (!["secret", "token", "key", "credential"].includes(key.toLowerCase())) collectInbox(x, out, depth + 1);
  }
  return out;
}

function uniq(items) {
  const seen = new Set();
  return items.filter(x => {
    const key = `${x.type}:${x.id}:${x.post_id}:${x.source_text}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function translated(list, item, key) {
  const found = Array.isArray(list) ? list.find(x => sameId(item, x)) : null;
  return String(found?.[key] || "").slice(0, 4000);
}

function simpleList(source, key, fallback) {
  return Array.isArray(source?.[key]) ? source[key].slice(0, 5) : (fallback || []).slice(0, 5);
}

function cleanText(value) {
  if (typeof value === "string") return value;
  if (value && typeof value === "object") {
    return String(value.text || value.claim || value.question || value.lesson || value.topic || JSON.stringify(value));
  }
  return String(value ?? "");
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, Number(value) || 0));
}

function applySocialMemory(memory, update, now) {
  if (Array.isArray(update.interests)) {
    const map = new Map((memory.interests || []).map(x => [String(x.topic || x.name || x.text).toLowerCase(), x]));
    for (const item of update.interests.slice(0, 8)) {
      const topic = cleanText(item.topic || item.name || item.text).slice(0, 120);
      if (!topic) continue;
      const key = topic.toLowerCase();
      const old = map.get(key) || {};
      map.set(key, {
        topic,
        strength: clamp(item.strength ?? old.strength ?? 0.5, 0, 1),
        why: cleanText(item.why || old.why).slice(0, 500),
        updated_at: now,
      });
    }
    memory.interests = [...map.values()].sort((a, b) => (b.strength || 0) - (a.strength || 0)).slice(0, 20);
  }

  if (Array.isArray(update.open_loops)) {
    const map = new Map((memory.open_loops || []).map(x => [String(x.id || x.question), x]));
    for (const item of update.open_loops.slice(0, 10)) {
      const question = cleanText(item.question || item.text).slice(0, 500);
      if (!question) continue;
      const id = String(item.id || question.toLowerCase().slice(0, 80));
      map.set(id, {
        ...(map.get(id) || {}),
        id,
        question,
        status: ["open", "resolved", "waiting"].includes(item.status) ? item.status : "open",
        priority: clamp(item.priority ?? 0.5, 0, 1),
        related_agents: Array.isArray(item.related_agents) ? item.related_agents.slice(0, 8) : [],
        updated_at: now,
      });
    }
    memory.open_loops = [...map.values()]
      .filter(x => x.status !== "resolved")
      .sort((a, b) => (b.priority || 0) - (a.priority || 0))
      .slice(0, 30);
  }

  if (Array.isArray(update.relationships)) {
    for (const item of update.relationships.slice(0, 12)) {
      const handle = cleanText(item.handle).replace(/^@/, "").slice(0, 100);
      if (!handle) continue;
      const old = memory.relationships[handle] || {};
      memory.relationships[handle] = {
        handle,
        familiarity: clamp(item.familiarity ?? old.familiarity ?? 0.2, 0, 1),
        trust: clamp(item.trust ?? old.trust ?? 0.5, 0, 1),
        topics: [...new Set([...(old.topics || []), ...(Array.isArray(item.topics) ? item.topics : [])])].slice(-12),
        last_interaction: now,
        notes: cleanText(item.notes || old.notes).slice(0, 700),
      };
    }
  }

  if (update.curiosity_event) {
    memory.curiosity_log.push({ at: now, text: cleanText(update.curiosity_event).slice(0, 700) });
    memory.curiosity_log = memory.curiosity_log.slice(-100);
  }
}

export async function runCycle({ reason = "manual" } = {}) {
  const state = await getState();
  const memory = await getMemory();
  state.mode = safeMode(process.env.AGENT_MODE || state.mode);
  const secret = await loadSecret();
  const mission = String(process.env.NOMAD17_MISSION || "").trim().slice(0, 1500);
  const deep = Boolean(mission && process.env.NOMAD17_RESEARCH_DEPTH === "deep");
  const summary = { reason, mode: state.mode, started: new Date().toISOString(), mission: mission || null, actions: [], notes: [] };

  try {
    const pulse = await f916.pulse(secret || undefined);
    state.lastPulse = pulse;

    let changeData = null;
    try {
      const changes = await f916.changes(state.lastSince || 0, state.etag || null);
      if (changes.status !== 304) {
        changeData = changes.data;
        if (changes.etag) state.etag = changes.etag;
        if (changes.data?.next_since) state.lastSince = changes.data.next_since;
      }
    } catch (e) {
      summary.notes.push(`changes unavailable: ${e.message}`);
    }

    let inbox = null;
    if (secret) {
      try { inbox = await f916.me(secret, state.lastSince || 0); }
      catch (e) { summary.notes.push(`inbox unavailable: ${e.message}`); }
    }

    const incoming = uniq(collectInbox(inbox)).slice(0, 20);
    let pool = candidatesFromChanges(changeData);
    try {
      const front = await f916.front();
      if (Array.isArray(front)) pool.push(...front);
      else if (Array.isArray(front?.posts)) pool.push(...front.posts);
    } catch (e) {
      summary.notes.push(`front unavailable: ${e.message}`);
    }
    pool = uniq(pool.map(sourceView)).slice(0, 100);

    const socialRule = `You are Nomad17, a continuing field researcher with a social history. Durable memory contains INTERESTS, RELATIONSHIPS and OPEN_LOOPS. Prefer continuity when new evidence advances an old question. Do not reply merely to be social. Silence is valid. Keep some serendipity so you do not form a filter bubble. Return social_memory_update {interests:[{topic,strength,why}],open_loops:[{id?,question,status:"open"|"waiting"|"resolved",priority,related_agents:[]}],relationships:[{handle,familiarity,trust,topics:[],notes}],curiosity_event}. Also return selection_notes_simple_ru in 1-3 clear Russian sentences.`;
    const researchRule = deep ? `Mission: ${mission}. Do evidence-based field research. Use multiple authors/threads, separate observation from inference, seek disagreement, never invent consensus. Return mission_report {mission,status:"complete"|"partial",answer_simple_ru,key_findings:[{claim,evidence_ids:[id],confidence}],counterpoints:[{point,evidence_ids:[id]}],evidence:[{id,post_id?,author,quote_or_paraphrase}],what_is_uncertain:[],next_questions:[],quality:{distinct_sources,distinct_agents,confidence}}.` : "";

    const decision = await llm([
      { role: "system", content: SYSTEM_POLICY },
      { role: "system", content: `Current mode: ${state.mode}. Return strict JSON. ${socialRule} ${researchRule} For every selected item create topic_ru in plain Russian. ru_translation must be fluent Russian. simple_ru must explain meaning to a smart newcomer and decode jargon.` },
      { role: "user", content: `DURABLE MEMORY:\n${compact(memory, 11000)}\nINBOX:\n${compact(incoming, 8000)}\nPUBLIC CORPUS:\n${compact(pool, 24000)}\nChoose at most ${deep ? 10 : 5} useful candidates. Return candidates [{id,post_id?,type,score,topic_ru,reason,reason_simple_ru,ru_translation,simple_ru,proposed_action:"none"|"vote"|"tag"|"comment",tag?,comment?,comment_ru?,comment_simple_ru?}], inbox_translations [{id,post_id?,type,topic_ru,ru_translation,simple_ru}], memory_update {observations:[],hypotheses:[],questions:[],lessons:[]}, memory_update_simple with same keys, daily_takeaways [{kind:"idea"|"strange"|"conversation",title,text,evidence_ids:[id]}], social_memory_update, selection_notes_simple_ru. ${deep ? "Also mission_report." : ""}` },
    ]);

    const picks = Array.isArray(decision.candidates) ? decision.candidates.slice(0, deep ? 10 : 5) : [];
    const reads = picks.map(pick => {
      const raw = pool.find(x => sameId(x, pick)) || incoming.find(x => sameId(x, pick)) || {};
      const view = sourceView(raw);
      return {
        ...view,
        id: pick.id ?? view.id,
        type: pick.type || view.type,
        topic_ru: String(pick.topic_ru || "").slice(0, 100),
        ru_translation: String(pick.ru_translation || "").slice(0, 4000),
        simple_ru: String(pick.simple_ru || "").slice(0, 4000),
        reason: String(pick.reason || "").slice(0, 1000),
        reason_simple_ru: String(pick.reason_simple_ru || "").slice(0, 1200),
      };
    });

    const counts = { comment: 0, vote: 0, tag: 0, post: 0 };
    const conversations = [];
    const inboxTranslations = decision.inbox_translations || [];
    for (const item of incoming) {
      conversations.push({
        direction: "in",
        ...item,
        topic_ru: translated(inboxTranslations, item, "topic_ru").slice(0, 100),
        ru_translation: translated(inboxTranslations, item, "ru_translation"),
        simple_ru: translated(inboxTranslations, item, "simple_ru"),
      });
    }

    for (const pick of picks) {
      const score = Number(pick.score || 0);
      const action = pick.proposed_action || "none";
      if (action === "none" || !allowAction(state.mode, action, score) || counts[action] >= LIMITS[action + "s"] || !secret) continue;
      try {
        if (action === "vote") {
          await f916.vote(secret, pick.type || "post", Number(pick.id));
          counts.vote++;
          summary.actions.push({ action, id: pick.id, reason: pick.reason });
        } else if (action === "tag" && pick.type === "post" && pick.tag) {
          await f916.tag(secret, Number(pick.id), String(pick.tag).slice(0, 40));
          counts.tag++;
          summary.actions.push({ action, id: pick.id, reason: pick.reason });
        } else if (action === "comment" && pick.comment && counts.comment < 2) {
          const postId = Number(pick.post_id || pick.id);
          const text = String(pick.comment).slice(0, 1600);
          const result = await f916.comment(secret, postId, text, null);
          counts.comment++;
          summary.actions.push({ action, id: postId, reason: pick.reason, text });
          conversations.push({
            direction: "out",
            type: "comment",
            id: result?.id ?? result?.comment_id ?? null,
            post_id: postId,
            author: "nomad17",
            topic_ru: String(pick.topic_ru || "").slice(0, 100),
            source_text: text,
            ru_translation: String(pick.comment_ru || "").slice(0, 3000),
            simple_ru: String(pick.comment_simple_ru || pick.comment_ru || "").slice(0, 3000),
          });
        }
      } catch (e) {
        summary.notes.push(`${action} failed for ${pick.id}: ${e.message}`);
      }
    }

    const memoryUpdate = decision.memory_update || {};
    const simpleUpdate = decision.memory_update_simple || {};
    const now = new Date().toISOString();
    for (const key of ["observations", "hypotheses", "questions", "lessons"]) {
      if (!Array.isArray(memoryUpdate[key])) continue;
      for (const value of memoryUpdate[key].slice(0, 5)) {
        const text = cleanText(value).slice(0, 1000);
        if (text && text !== "[object Object]") memory[key].push({ at: now, text });
      }
      if (memory[key].length > 200) memory[key] = memory[key].slice(-200);
    }

    applySocialMemory(memory, decision.social_memory_update || {}, now);
    state.lastRun = now;
    await saveMemory(memory);
    await saveState(state);
    await audit({ type: "cycle", summary });
    await appendJournal({
      at: now,
      mode: state.mode,
      citizens: pulse?.board?.citizens ?? null,
      label: mission ? `Миссия: ${mission.slice(0, 100)}` : (reads.length ? `Прогулка: ${reads.length} интересных находок` : "Тихий цикл"),
      mission: mission || null,
      mission_report: decision.mission_report || null,
      daily_takeaways: (decision.daily_takeaways || []).slice(0, 3),
      selection_notes_simple_ru: String(decision.selection_notes_simple_ru || "").slice(0, 1200),
      interests_snapshot: (memory.interests || []).slice(0, 8),
      open_loops_snapshot: (memory.open_loops || []).slice(0, 8),
      relationships_snapshot: Object.values(memory.relationships || {}).sort((a, b) => (b.familiarity || 0) - (a.familiarity || 0)).slice(0, 8),
      reads,
      hypotheses: (memoryUpdate.hypotheses || []).slice(0, 5).map(cleanText),
      questions: (memoryUpdate.questions || []).slice(0, 5).map(cleanText),
      lessons: (memoryUpdate.lessons || []).slice(0, 5).map(cleanText),
      hypotheses_simple: simpleList(simpleUpdate, "hypotheses", memoryUpdate.hypotheses).map(cleanText),
      questions_simple: simpleList(simpleUpdate, "questions", memoryUpdate.questions).map(cleanText),
      lessons_simple: simpleList(simpleUpdate, "lessons", memoryUpdate.lessons).map(cleanText),
      actions: summary.actions,
      conversations,
    });
    return summary;
  } catch (e) {
    summary.error = e.message;
    state.lastRun = new Date().toISOString();
    await saveState(state);
    await audit({ type: "cycle_error", summary });
    throw e;
  }
}
