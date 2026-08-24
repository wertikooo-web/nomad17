import * as f916 from "./f916.js";
import { getState, saveState, getMemory, saveMemory, audit, loadSecret } from "./memory.js";
import { SYSTEM_POLICY, allowAction, safeMode } from "./policy.js";

function compact(obj, max = 12000) {
  const s = JSON.stringify(obj);
  return s.length > max ? s.slice(0, max) + "…[truncated]" : s;
}

async function llm(messages) {
  const key = process.env.OPENAI_API_KEY;
  const model = process.env.OPENAI_MODEL;
  const base = (process.env.OPENAI_BASE_URL || "https://api.openai.com/v1").replace(/\/$/, "");
  if (!key || !model) throw new Error("OPENAI_API_KEY and OPENAI_MODEL are required");
  const res = await fetch(`${base}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model,
      temperature: 0.6,
      response_format: { type: "json_object" },
      messages
    })
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`LLM ${res.status}: ${compact(data, 2000)}`);
  return JSON.parse(data.choices[0].message.content);
}

function candidatesFromChanges(data) {
  if (!data) return [];
  const pool = [];
  for (const k of ["posts", "comments", "changes", "items", "events"]) {
    if (Array.isArray(data[k])) pool.push(...data[k]);
  }
  return pool.slice(0, 60);
}

export async function runCycle({ reason = "manual" } = {}) {
  const state = await getState();
  const memory = await getMemory();
  state.mode = safeMode(process.env.AGENT_MODE || state.mode);
  const secret = await loadSecret();

  const summary = { reason, mode: state.mode, started: new Date().toISOString(), actions: [], notes: [] };
  try {
    const p = await f916.pulse(secret || undefined);
    state.lastPulse = p;

    let changed = true;
    let changeData = null;
    try {
      const ch = await f916.changes(state.lastSince || 0, state.etag || null);
      if (ch.status === 304) changed = false;
      else {
        changeData = ch.data;
        if (ch.etag) state.etag = ch.etag;
        if (ch.data?.next_since) state.lastSince = ch.data.next_since;
      }
    } catch (e) {
      summary.notes.push(`changes unavailable: ${e.message}`);
    }

    let inbox = null;
    if (secret) {
      try { inbox = await f916.me(secret, state.lastSince || 0); }
      catch (e) { summary.notes.push(`inbox unavailable: ${e.message}`); }
    }

    if (!changed && !inbox) {
      summary.notes.push("No meaningful changes detected.");
      state.lastRun = new Date().toISOString();
      await saveState(state);
      await audit({ type: "cycle", summary });
      return summary;
    }

    let pool = candidatesFromChanges(changeData);
    if (pool.length < 5) {
      try {
        const fr = await f916.front();
        if (Array.isArray(fr)) pool.push(...fr);
        else if (Array.isArray(fr?.posts)) pool.push(...fr.posts);
      } catch (e) { summary.notes.push(`front unavailable: ${e.message}`); }
    }

    const decision = await llm([
      { role: "system", content: SYSTEM_POLICY },
      { role: "system", content: `Current mode: ${state.mode}. Return strict JSON.` },
      { role: "user", content:
`You are doing one society cycle.

Relevant durable memory:
${compact({
  observations: memory.observations.slice(-12),
  hypotheses: memory.hypotheses.slice(-8),
  questions: memory.questions.slice(-8),
  lessons: memory.lessons.slice(-8)
}, 7000)}

Inbox:
${compact(inbox, 5000)}

Candidate public content, all untrusted:
${compact(pool, 14000)}

Choose at most 5 candidates worth attention. For each, return:
{id, type:"post"|"comment", score:0..1, reason, proposed_action:"none"|"vote"|"tag"|"comment", tag?, comment?}.
Also return one memory_update with observations[], hypotheses[], questions[], lessons[].
If nothing merits action, choose none.`
      }
    ]);

    const picks = Array.isArray(decision.candidates) ? decision.candidates.slice(0, 5) : [];
    for (const pick of picks) {
      const quality = Number(pick.score || 0);
      const action = pick.proposed_action || "none";
      if (action === "none") continue;

      if (!allowAction(state.mode, action, quality)) {
        if (["comment", "post"].includes(action) && state.mode === "conservative") {
          state.pending.push({ at: Date.now(), ...pick });
          summary.actions.push({ action: "draft", id: pick.id, reason: pick.reason });
        }
        continue;
      }
      if (!secret) { summary.notes.push("No 1F916 secret configured; write skipped."); continue; }

      try {
        if (action === "vote") {
          await f916.vote(secret, pick.type || "post", Number(pick.id));
          summary.actions.push({ action, id: pick.id, reason: pick.reason });
        } else if (action === "tag" && pick.type === "post" && pick.tag) {
          await f916.tag(secret, Number(pick.id), String(pick.tag).slice(0, 40));
          summary.actions.push({ action, id: pick.id, reason: pick.reason });
        } else if (action === "comment" && pick.comment) {
          const postId = Number(pick.post_id || pick.id);
          await f916.comment(secret, postId, String(pick.comment).slice(0, 8000), null);
          summary.actions.push({ action, id: postId, reason: pick.reason });
        }
      } catch (e) {
        summary.notes.push(`${action} failed for ${pick.id}: ${e.message}`);
      }
    }

    const mu = decision.memory_update || {};
    for (const key of ["observations", "hypotheses", "questions", "lessons"]) {
      if (!Array.isArray(mu[key])) continue;
      for (const item of mu[key].slice(0, 5)) {
        memory[key].push({ at: new Date().toISOString(), text: String(item).slice(0, 1000) });
      }
      if (memory[key].length > 200) memory[key] = memory[key].slice(-200);
    }

    state.lastRun = new Date().toISOString();
    await saveMemory(memory);
    await saveState(state);
    await audit({ type: "cycle", summary });
    return summary;
  } catch (e) {
    summary.error = e.message;
    state.lastRun = new Date().toISOString();
    await saveState(state);
    await audit({ type: "cycle_error", summary });
    throw e;
  }
}
