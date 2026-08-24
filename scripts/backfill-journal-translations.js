import fs from 'node:fs/promises';

const file = 'docs/journal.json';
const key = process.env.OPENAI_API_KEY;
const model = process.env.OPENAI_MODEL;
const base = (process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/$/, '');
if (!key || !model) throw new Error('OPENAI_API_KEY and OPENAI_MODEL are required');

const journal = JSON.parse(await fs.readFile(file, 'utf8'));
const items = [];
for (const cycle of journal.cycles || []) {
  for (const r of cycle.reads || []) if (r.source_text) items.push({kind:'read',ref:r,source:r.source_text,reason:r.reason||''});
  for (const m of cycle.conversations || []) if (m.source_text) items.push({kind:'message',ref:m,source:m.source_text});
}

async function translate(batch) {
  const payload=batch.map((x,i)=>({i,kind:x.kind,source:x.source,reason:x.reason||''}));
  const res=await fetch(`${base}/chat/completions`,{method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${key}`},body:JSON.stringify({model,temperature:0.15,response_format:{type:'json_object'},messages:[
    {role:'system',content:`You are an expert editor translating conversations between AI agents for a non-technical Russian reader. Return strict JSON {items:[{i,topic_ru,ru_translation,simple_ru,reason_simple_ru?}]}.
TOPIC_RU: 2-6 Russian words answering “О чём здесь речь?”. Use an immediately understandable subject label, for example “накрутка голосов”, “память между сессиями”, “экономика сообщества”, “доверие к агентам”. Never use unexplained internal jargon.
RU_TRANSLATION: fluent natural Russian preserving actual meaning, facts, numbers, names, URLs, uncertainty and necessary technical terms. Do not copy English syntax.
SIMPLE_RU: explain what the speaker means to an intelligent friend who knows nothing about this agent society. Make clear what happened, what is being claimed or asked, and why it matters. Decode jargon and implied context. Restructure freely. Preserve material facts and caveats. Avoid bureaucratic Russian and literal calques. Internal terms must be explained immediately. For messages use normally 2-5 clear sentences.
REASON_SIMPLE_RU: plainly explain why Nomad17 found the item interesting and what deserves checking.`},
    {role:'user',content:JSON.stringify(payload)}]})});
  const data=await res.json();if(!res.ok)throw new Error(`LLM ${res.status}: ${JSON.stringify(data).slice(0,1000)}`);return JSON.parse(data.choices[0].message.content).items||[];
}
for(let i=0;i<items.length;i+=8){const batch=items.slice(i,i+8),out=await translate(batch);for(const t of out){const x=batch[Number(t.i)];if(!x)continue;if(t.topic_ru)x.ref.topic_ru=String(t.topic_ru).slice(0,100);if(t.ru_translation)x.ref.ru_translation=String(t.ru_translation);if(t.simple_ru)x.ref.simple_ru=String(t.simple_ru);if(x.kind==='read'&&t.reason_simple_ru)x.ref.reason_simple_ru=String(t.reason_simple_ru)}console.log(`rewritten ${Math.min(i+batch.length,items.length)}/${items.length}`)}
await fs.writeFile(file,JSON.stringify(journal,null,2));console.log(`done: ${items.length} records rewritten`);
