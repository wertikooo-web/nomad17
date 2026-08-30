import fs from 'node:fs/promises';

const journalFile='docs/journal.json', memoryFile='data/memory.json';
// Same model run-once.js's router uses (see that file's comment): the retired
// "stealth/ox-alpha" slug's real name needs OpenRouter credits the account
// doesn't have, so the project runs on minimax/minimax-m2.7:free instead.
// Hardcoded rather than read from OPENAI_MODEL so this script doesn't
// silently break again if that secret still holds a stale slug.
const key=process.env.OPENAI_API_KEY, model='minimax/minimax-m2.7:free';
const base=(process.env.OPENAI_BASE_URL||'https://api.openai.com/v1').replace(/\/$/,'');
if(!key) throw new Error('OPENAI_API_KEY is required');

const journal=JSON.parse(await fs.readFile(journalFile,'utf8'));
const memory=JSON.parse(await fs.readFile(memoryFile,'utf8'));
const bad=x=>String(x?.text??x??'').trim()==='[object Object]';
for(const k of ['observations','hypotheses','questions','lessons']) if(Array.isArray(memory[k])) memory[k]=memory[k].filter(x=>!bad(x));

const sensible=(v,fallback)=>{const n=Number(v);return Number.isFinite(n)&&n>0?Math.min(1,n):fallback};
for(const x of memory.interests||[]) x.strength=sensible(x.strength,.55);
for(const x of memory.open_loops||[]) x.priority=sensible(x.priority,.55);
for(const x of Object.values(memory.relationships||{})){x.familiarity=sensible(x.familiarity,.25);x.trust=sensible(x.trust,.5)}

// This script used to re-translate EVERY item in ALL cached cycles (up to 120)
// on every single run, which made it take 15+ minutes and hit the workflow's
// own timeout-minutes ceiling every time (confirmed: run 32876237060 got
// cancelled at exactly 15:00 still on the first "translate" step). Only queue
// items that are actually missing a translation or visibly broken
// ("[object Object]", the nested-object-coerced-to-string bug) — already-good
// Russian text (detected by the presence of Cyrillic) is left alone.
const hasCyrillic = s => /[а-яё]/i.test(String(s||''));
const isBroken = s => String(s||'').trim()==='[object Object]';
const needsFix = (...vals) => vals.some(v => isBroken(v)) || !vals.every(v => hasCyrillic(v));

const items=[];
for(const cycle of journal.cycles||[]){
  for(const r of cycle.reads||[]) if(r.source_text && needsFix(r.ru_translation, r.simple_ru)) items.push({kind:'read',ref:r,source:r.source_text,reason:r.reason||''});
  for(const m of cycle.conversations||[]) if(m.source_text && needsFix(m.ru_translation, m.simple_ru)) items.push({kind:'message',ref:m,source:m.source_text});
  if(cycle.selection_notes_simple_ru && needsFix(cycle.selection_notes_simple_ru)) items.push({kind:'selection',ref:cycle,source:cycle.selection_notes_simple_ru});
  for(const x of cycle.interests_snapshot||[]) if(needsFix(x.why_ru||x.why)) items.push({kind:'interest',ref:x,source:`topic: ${x.topic||''}\nwhy: ${x.why||''}`});
  for(const x of cycle.open_loops_snapshot||[]) if(needsFix(x.question_ru||x.question)) items.push({kind:'loop',ref:x,source:x.question||''});
  for(const x of cycle.relationships_snapshot||[]) if(needsFix(x.notes_ru||x.notes)) items.push({kind:'relationship',ref:x,source:`notes: ${x.notes||''}\ntopics: ${(x.topics||[]).join(', ')}`});
}
console.log(`[backfill] ${items.length} items need translation (skipped already-good ones)`);

// The translator model occasionally emits a literal, unescaped control character
// (usually a raw newline) inside a JSON string value instead of writing "\n",
// which fails a strict JSON.parse. response_format:json_object only guarantees
// the model intends valid JSON, not that every provider enforces it
// byte-for-byte, so repair defensively before giving up. Walking the string and
// re-escaping control bytes avoids embedding any raw control byte in this
// source file.
function parseJsonSafe(text) {
  try { return JSON.parse(text); } catch {}
  // minimax/minimax-m2.7:free sometimes wraps its JSON in a ```json fence even
  // with response_format:json_object set.
  const fence = String(text).match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence?.[1]) { try { return JSON.parse(fence[1].trim()); } catch {} }
  let repaired = '';
  for (const ch of String(fence?.[1] || text)) {
    const code = ch.codePointAt(0);
    if (code === 10) repaired += '\\n';
    else if (code === 13) repaired += '\\r';
    else if (code === 9) repaired += '\\t';
    else if (code < 32) continue;
    else repaired += ch;
  }
  return JSON.parse(repaired);
}
// Same rationale as src/agent.js's flattenRu(): the translator model sometimes
// returns a nested {label: text} object where a single string was asked for,
// which used to render as the literal text "[object Object]" on the dashboard.
function flattenRu(value) {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(flattenRu).filter(Boolean).join(' ');
  if (value && typeof value === 'object') return Object.entries(value).map(([k, v]) => `${k}: ${flattenRu(v)}`).join(' ');
  return String(value ?? '');
}

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

// stealth/ox-alpha is served through OpenRouter's shared, rate-limited pool and
// returns an explicit, transient 429 under load (same evidence as run-once.js's
// router) — retry a few times with backoff instead of failing the whole batch.
async function translate(batch){
  const payload=batch.map((x,i)=>({i,kind:x.kind,source:x.source,reason:x.reason||''}));
  for (let attempt = 1; attempt <= 4; attempt++) {
    const res=await fetch(`${base}/chat/completions`,{method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${key}`},body:JSON.stringify({model,temperature:.15,response_format:{type:'json_object'},messages:[
      {role:'system',content:`Return strict JSON {items:[{i,topic_ru,ru_translation,simple_ru,reason_simple_ru?}]}. All *_ru fields MUST be plain strings (never nested JSON objects) in Russian Cyrillic unless a proper name or code token must stay Latin. Translate meaning, not English word order. simple_ru must explain context to a smart newcomer. topic_ru is 2-6 plain Russian words. For selection/interest/loop/relationship, simple_ru should be a clear Russian explanation of the supplied text.`},
      {role:'user',content:JSON.stringify(payload)}]})});
    if (res.status === 429 && attempt < 4) { console.warn(`[backfill] 429, retry ${attempt}/3 after backoff`); await sleep(5000 * attempt); continue; }
    const data=await res.json();if(!res.ok)throw new Error(`LLM ${res.status}: ${JSON.stringify(data).slice(0,1000)}`);return (parseJsonSafe(data.choices[0].message.content).items||[]);
  }
}

// Write-then-rename so a process kill (timeout-minutes SIGKILL) mid-write can
// never leave docs/journal.json or data/memory.json truncated/corrupt for the
// dashboard to load — the rename is atomic, an in-progress write is not.
async function writeJsonAtomic(file, value){
  const tmp = `${file}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(value, null, 2));
  await fs.rename(tmp, file);
}
async function save(){
  const latest=(journal.cycles||[])[0];
  if(latest){for(const x of latest.interests_snapshot||[])x.strength=sensible(x.strength,.55);for(const x of latest.open_loops_snapshot||[])x.priority=sensible(x.priority,.55);for(const x of latest.relationships_snapshot||[]){x.familiarity=sensible(x.familiarity,.25);x.trust=sensible(x.trust,.5)}}
  await writeJsonAtomic(journalFile, journal);
  await writeJsonAtomic(memoryFile, memory);
}

// Save every few batches, not just at the very end: if a big first-time backlog
// makes this script run long enough to hit the workflow's own timeout-minutes,
// GitHub SIGKILLs the whole job and anything not yet written to disk is lost.
// Incremental saves mean a timeout only loses the batch in flight, not the
// entire run's progress.
let done=0;
for(let i=0;i<items.length;i+=8){const batch=items.slice(i,i+8);let out;try{out=await translate(batch)}catch(e){console.warn(`[backfill] batch ${i}-${i+batch.length} failed, skipping: ${e.message}`);continue}for(const t of out){const x=batch[Number(t.i)];if(!x)continue;const r=x.ref;if(x.kind==='read'||x.kind==='message'){if(t.topic_ru)r.topic_ru=flattenRu(t.topic_ru);if(t.ru_translation)r.ru_translation=flattenRu(t.ru_translation);if(t.simple_ru)r.simple_ru=flattenRu(t.simple_ru);if(x.kind==='read'&&t.reason_simple_ru)r.reason_simple_ru=flattenRu(t.reason_simple_ru)}else if(x.kind==='selection'){r.selection_notes_simple_ru=flattenRu(t.simple_ru||t.ru_translation||x.source)}else if(x.kind==='interest'){const topic=flattenRu(t.topic_ru||r.topic||'');const why=flattenRu(t.simple_ru||t.ru_translation||r.why||'');r.topic=topic;r.why=why;r.topic_ru=topic;r.why_ru=why;r.strength=sensible(r.strength,.55)}else if(x.kind==='loop'){const q=flattenRu(t.simple_ru||t.ru_translation||r.question||'');r.question=q;r.question_ru=q;r.priority=sensible(r.priority,.55)}else if(x.kind==='relationship'){const notes=flattenRu(t.simple_ru||t.ru_translation||r.notes||'');r.notes=notes;r.notes_ru=notes;if(t.topic_ru)r.topics=[flattenRu(t.topic_ru)];r.familiarity=sensible(r.familiarity,.25);r.trust=sensible(r.trust,.5)}}
  done+=batch.length;
  await save();
}

await save();
console.log(`done: ${items.length} journal records normalized and translated`);
