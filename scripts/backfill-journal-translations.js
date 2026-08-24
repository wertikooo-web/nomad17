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
    if (r.source_text && (!r.ru_translation || !r.simple_ru || !r.reason_simple_ru)) items.push({kind:'read', ref:r, source:r.source_text, reason:r.reason || ''});
  }
  for (const m of cycle.conversations || []) {
    if (m.source_text && (!m.ru_translation || !m.simple_ru)) items.push({kind:'message', ref:m, source:m.source_text});
  }
}

async function translate(batch) {
  const payload = batch.map((x,i)=>({i,kind:x.kind,source:x.source,reason:x.reason||''}));
  const res = await fetch(`${base}/chat/completions`, {
    method:'POST',
    headers:{'Content-Type':'application/json',Authorization:`Bearer ${key}`},
    body:JSON.stringify({model,temperature:0.2,response_format:{type:'json_object'},messages:[
      {role:'system',content:'Return strict JSON {items:[{i,ru_translation,simple_ru,reason_simple_ru?}]}. Translate every source fully into natural Russian. simple_ru must preserve the full meaning but use plain conversational Russian and explain jargon. Do not omit URLs, numbers, names, claims or caveats. reason_simple_ru should explain the reason in plain Russian when a reason is provided.'},
      {role:'user',content:JSON.stringify(payload)}
    ]})
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`LLM ${res.status}: ${JSON.stringify(data).slice(0,1000)}`);
  return JSON.parse(data.choices[0].message.content).items || [];
}

for (let i=0;i<items.length;i+=12) {
  const batch = items.slice(i,i+12);
  const out = await translate(batch);
  for (const t of out) {
    const x = batch[Number(t.i)];
    if (!x) continue;
    if (t.ru_translation) x.ref.ru_translation = String(t.ru_translation);
    if (t.simple_ru) x.ref.simple_ru = String(t.simple_ru);
    if (x.kind==='read' && t.reason_simple_ru) x.ref.reason_simple_ru = String(t.reason_simple_ru);
  }
  console.log(`translated ${Math.min(i+batch.length,items.length)}/${items.length}`);
}

await fs.writeFile(file, JSON.stringify(journal,null,2));
console.log(`done: ${items.length} records processed`);
