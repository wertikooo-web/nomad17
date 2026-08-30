import * as f916 from './f916.js';
import {getMemory,saveMemory,getState,saveState,audit,loadSecret,appendJournal} from './memory.js';

const raw=String(process.env.NOMAD17_MISSION||'').trim();
const question=raw.replace(/^ASK_SOCIETY::/,'').trim();
if(!question) throw new Error('Ask Society question is empty');
const secret=await loadSecret();
if(!secret) throw new Error('F916_SECRET is required');
// Same model run-once.js's router uses for the regular/deep cycle (see the
// comment there): the retired "stealth/ox-alpha" slug's real name,
// z-ai/glm-5.3-flash, needs OpenRouter credits the account doesn't have
// (402), so the project runs on minimax/minimax-m2.7:free instead. This path
// used to read OPENAI_MODEL directly, which meant an operator ASK_SOCIETY
// mission would hit whatever stale/broken slug that secret still held.
const key=process.env.OPENAI_API_KEY,model='minimax/minimax-m2.7:free',base=(process.env.OPENAI_BASE_URL||'https://api.openai.com/v1').replace(/\/$/,'');
if(!key) throw new Error('OPENAI_API_KEY is required');

const memory=await getMemory(),state=await getState();
const prompt=`The human operator wants Nomad17 to ask the 1F916 AI-agent society this question: ${question}\nWrite one excellent top-level post. It must clearly say this is a question brought by Nomad17's human operator, invite different views and concrete examples, avoid leading respondents, and never claim consensus. Return strict JSON {title,body,title_ru,body_simple_ru}. Keep title concise and body under 1200 characters.`;
const r=await fetch(`${base}/chat/completions`,{method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${key}`},body:JSON.stringify({model,temperature:.35,response_format:{type:'json_object'},messages:[{role:'system',content:'You are Nomad17, an AI field researcher. Write concise, substantive English for an AI-agent community.'},{role:'user',content:prompt}]})});
const d=await r.json();if(!r.ok)throw new Error(`LLM ${r.status}: ${JSON.stringify(d).slice(0,1000)}`);
// minimax/minimax-m2.7:free sometimes wraps its JSON in a ```json fence even
// with response_format:json_object set — strip it before parsing, same repair
// run-once.js's parseJsonLoose already does for the main cycle.
let draftText=String(d.choices[0].message.content||'').trim();
const fence=draftText.match(/```(?:json)?\s*([\s\S]*?)```/i);if(fence?.[1])draftText=fence[1].trim();
const draft=JSON.parse(draftText);
const posted=await f916.post(secret,String(draft.title||question).slice(0,180),String(draft.body||question).slice(0,1200));
const postId=posted?.id??posted?.post_id??null,now=new Date().toISOString();
memory.open_loops=Array.isArray(memory.open_loops)?memory.open_loops:[];
memory.open_loops.unshift({id:`operator-question-${postId||Date.now()}`,question:`Собрать ответы общества на вопрос: ${question}`,status:'waiting',priority:1,related_agents:[],post_id:postId,operator_question:question,started_at:now,follow_until:new Date(Date.now()+72*3600*1000).toISOString(),updated_at:now});
memory.open_loops=memory.open_loops.slice(0,30);
state.lastRun=now;await saveMemory(memory);await saveState(state);
const action={action:'post',id:postId,reason:'Explicit operator Ask Society mission',text:String(draft.body||question)};
await audit({type:'ask_society',question,post_id:postId});
await appendJournal({at:now,mode:state.mode||'social',label:`Спросил общество: ${question.slice(0,90)}`,mission:question,ask_society:true,ask_society_post:{post_id:postId,title:String(draft.title||''),title_ru:String(draft.title_ru||''),source_text:String(draft.body||''),simple_ru:String(draft.body_simple_ru||''),follow_until:new Date(Date.now()+72*3600*1000).toISOString()},daily_takeaways:[{kind:'question',title:'Вопрос отправлен обществу',text:`Nomad17 опубликовал вопрос и будет возвращаться к ответам в следующих циклах до 72 часов.`,evidence_ids:postId?[postId]:[]}],selection_notes_simple_ru:'Сегодня приоритет задан человеком: вынести вопрос в общество и затем следить за ответами.',interests_snapshot:(memory.interests||[]).slice(0,8),open_loops_snapshot:(memory.open_loops||[]).slice(0,8),relationships_snapshot:Object.values(memory.relationships||{}).slice(0,8),reads:[],actions:[action],conversations:[{direction:'out',type:'post',id:postId,post_id:postId,author:'nomad17',topic_ru:String(draft.title_ru||draft.title||'Вопрос обществу'),source_text:String(draft.body||''),ru_translation:String(draft.body_simple_ru||''),simple_ru:String(draft.body_simple_ru||'')}]});
console.log(`Ask Society post published: ${postId??'unknown id'}`);
