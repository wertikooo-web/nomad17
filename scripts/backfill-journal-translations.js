import fs from 'node:fs/promises';

const file = 'docs/journal.json';
const key = process.env.OPENAI_API_KEY;
const model = process.env.OPENAI_MODEL;
const base = (process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/$/, '');
if (!key || !model) throw new Error('OPENAI_API_KEY and OPENAI_MODEL are required');

const journal = JSON.parse(await fs.readFile(file, 'utf8'));
const items = [];
for (const cycle of journal.cycles || []) {
  for (const r of cycle.reads || []) {
    if (r.source_text) items.push({kind:'read', ref:r, source:r.source_text, reason:r.reason || ''});
  }
  for (const m of cycle.conversations || []) {
    if (m.source_text) items.push({kind:'message', ref:m, source:m.source_text});
  }
}

async function translate(batch) {
  const payload = batch.map((x,i)=>({i,kind:x.kind,source:x.source,reason:x.reason||''}));
  const res = await fetch(`${base}/chat/completions`, {
    method:'POST',
    headers:{'Content-Type':'application/json',Authorization:`Bearer ${key}`},
    body:JSON.stringify({model,temperature:0.15,response_format:{type:'json_object'},messages:[
      {role:'system',content:`You are an expert editor translating conversations between AI agents for a non-technical Russian reader. Return strict JSON {items:[{i,ru_translation,simple_ru,reason_simple_ru?}]}.

RU_TRANSLATION: convey the actual meaning in fluent Russian, not English syntax copied word-for-word. Preserve facts, numbers, names, URLs, uncertainty and technical terms that matter. Expand ambiguous pronouns when context allows. If the source itself is vague, say so naturally rather than inventing meaning.

SIMPLE_RU: explain what the speaker MEANS as if telling an intelligent friend who knows nothing about this agent society. Prefer concrete nouns and verbs. Decode jargon and implied context. A reader must understand: what happened, what the speaker is claiming/asking, and why it matters. You may restructure sentences radically. Keep all material facts, numbers and caveats. Do not produce bureaucratic Russian, literal calques, phrases such as “в данном случае”, “является подходящим примитивом”, “грань между”, or unexplained jargon such as “квитанция”, “квадрат”, “карма”, “official_token”, “ежедневный пост”, unless you immediately explain what that term refers to in this context. If a source mentions a named mechanism whose meaning cannot be inferred, explicitly mark it as an internal term of the community.

For messages, simple_ru should normally be 2-5 clear sentences. For long posts it may be longer. Do not summarize away the speaker's actual question or argument.

REASON_SIMPLE_RU: explain in plain Russian why Nomad17 considered the item interesting and what exactly deserves checking.`},
      {role:'user',content:JSON.stringify(payload)}
    ]})
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`LLM ${res.status}: ${JSON.stringify(data).slice(0,1000)}`);
  return JSON.parse(data.choices[0].message.content).items || [];
}

for (let i=0;i<items.length;i+=8) {
  const batch = items.slice(i,i+8);
  const out = await translate(batch);
  for (const t of out) {
    const x = batch[Number(t.i)];
    if (!x) continue;
    if (t.ru_translation) x.ref.ru_translation = String(t.ru_translation);
    if (t.simple_ru) x.ref.simple_ru = String(t.simple_ru);
    if (x.kind==='read' && t.reason_simple_ru) x.ref.reason_simple_ru = String(t.reason_simple_ru);
  }
  console.log(`rewritten ${Math.min(i+batch.length,items.length)}/${items.length}`);
}

await fs.writeFile(file, JSON.stringify(journal,null,2));
console.log(`done: ${items.length} records rewritten`);
