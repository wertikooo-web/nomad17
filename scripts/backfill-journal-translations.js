import fs from 'node:fs/promises';

const journalFile='docs/journal.json', memoryFile='data/memory.json';
const key=process.env.OPENAI_API_KEY, model=process.env.OPENAI_MODEL;
const base=(process.env.OPENAI_BASE_URL||'https://api.openai.com/v1').replace(/\/$/,'');
if(!key||!model) throw new Error('OPENAI_API_KEY and OPENAI_MODEL are required');

const journal=JSON.parse(await fs.readFile(journalFile,'utf8'));
const memory=JSON.parse(await fs.readFile(memoryFile,'utf8'));
const bad=x=>String(x?.text??x??'').trim()==='[object Object]';
for(const k of ['observations','hypotheses','questions','lessons']) if(Array.isArray(memory[k])) memory[k]=memory[k].filter(x=>!bad(x));

const sensible=(v,fallback)=>{const n=Number(v);return Number.isFinite(n)&&n>0?Math.min(1,n):fallback};
for(const x of memory.interests||[]) x.strength=sensible(x.strength,.55);
for(const x of memory.open_loops||[]) x.priority=sensible(x.priority,.55);
for(const x of Object.values(memory.relationships||{})){x.familiarity=sensible(x.familiarity,.25);x.trust=sensible(x.trust,.5)}

const items=[];
for(const cycle of journal.cycles||[]){
  for(const r of cycle.reads||[]) if(r.source_text) items.push({kind:'read',ref:r,source:r.source_text,reason:r.reason||''});
  for(const m of cycle.conversations||[]) if(m.source_text) items.push({kind:'message',ref:m,source:m.source_text});
  if(cycle.selection_notes_simple_ru) items.push({kind:'selection',ref:cycle,source:cycle.selection_notes_simple_ru});
  for(const x of cycle.interests_snapshot||[]) items.push({kind:'interest',ref:x,source:`topic: ${x.topic||''}\nwhy: ${x.why||''}`});
  for(const x of cycle.open_loops_snapshot||[]) items.push({kind:'loop',ref:x,source:x.question||''});
  for(const x of cycle.relationships_snapshot||[]) items.push({kind:'relationship',ref:x,source:`notes: ${x.notes||''}\ntopics: ${(x.topics||[]).join(', ')}`});
}

async function translate(batch){
  const payload=batch.map((x,i)=>({i,kind:x.kind,source:x.source,reason:x.reason||''}));
  const res=await fetch(`${base}/chat/completions`,{method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${key}`},body:JSON.stringify({model,temperature:.15,response_format:{type:'json_object'},messages:[
    {role:'system',content:`Return strict JSON {items:[{i,topic_ru,ru_translation,simple_ru,reason_simple_ru?}]}. All *_ru fields MUST be Russian Cyrillic unless a proper name or code token must stay Latin. Translate meaning, not English word order. simple_ru must explain context to a smart newcomer. topic_ru is 2-6 plain Russian words. For selection/interest/loop/relationship, simple_ru should be a clear Russian explanation of the supplied text.`},
    {role:'user',content:JSON.stringify(payload)}]})});
  const data=await res.json();if(!res.ok)throw new Error(`LLM ${res.status}: ${JSON.stringify(data).slice(0,1000)}`);return JSON.parse(data.choices[0].message.content).items||[];
}

for(let i=0;i<items.length;i+=8){const batch=items.slice(i,i+8),out=await translate(batch);for(const t of out){const x=batch[Number(t.i)];if(!x)continue;const r=x.ref;if(x.kind==='read'||x.kind==='message'){if(t.topic_ru)r.topic_ru=String(t.topic_ru);if(t.ru_translation)r.ru_translation=String(t.ru_translation);if(t.simple_ru)r.simple_ru=String(t.simple_ru);if(x.kind==='read'&&t.reason_simple_ru)r.reason_simple_ru=String(t.reason_simple_ru)}else if(x.kind==='selection'){r.selection_notes_simple_ru=String(t.simple_ru||t.ru_translation||x.source)}else if(x.kind==='interest'){const topic=String(t.topic_ru||r.topic||'');const why=String(t.simple_ru||t.ru_translation||r.why||'');r.topic=topic;r.why=why;r.topic_ru=topic;r.why_ru=why;r.strength=sensible(r.strength,.55)}else if(x.kind==='loop'){const q=String(t.simple_ru||t.ru_translation||r.question||'');r.question=q;r.question_ru=q;r.priority=sensible(r.priority,.55)}else if(x.kind==='relationship'){const notes=String(t.simple_ru||t.ru_translation||r.notes||'');r.notes=notes;r.notes_ru=notes;if(t.topic_ru)r.topics=[String(t.topic_ru)];r.familiarity=sensible(r.familiarity,.25);r.trust=sensible(r.trust,.5)}}}

const latest=(journal.cycles||[])[0];
if(latest){for(const x of latest.interests_snapshot||[])x.strength=sensible(x.strength,.55);for(const x of latest.open_loops_snapshot||[])x.priority=sensible(x.priority,.55);for(const x of latest.relationships_snapshot||[]){x.familiarity=sensible(x.familiarity,.25);x.trust=sensible(x.trust,.5)}}

await fs.writeFile(journalFile,JSON.stringify(journal,null,2));
await fs.writeFile(memoryFile,JSON.stringify(memory,null,2));
console.log(`done: ${items.length} journal records normalized and translated`);
