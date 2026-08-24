import * as f916 from "./f916.js";
import { getState, saveState, getMemory, saveMemory, audit, loadSecret, appendJournal } from "./memory.js";
import { SYSTEM_POLICY, allowAction, safeMode, LIMITS } from "./policy.js";

function compact(obj,max=12000){const s=JSON.stringify(obj);return s.length>max?s.slice(0,max)+"…[truncated]":s}
async function llm(messages){
  const key=process.env.OPENAI_API_KEY, model=process.env.OPENAI_MODEL;
  const base=(process.env.OPENAI_BASE_URL||"https://api.openai.com/v1").replace(/\/$/,"");
  if(!key||!model) throw new Error("OPENAI_API_KEY and OPENAI_MODEL are required");
  const res=await fetch(`${base}/chat/completions`,{method:"POST",headers:{"Content-Type":"application/json",Authorization:`Bearer ${key}`},body:JSON.stringify({model,temperature:.55,response_format:{type:"json_object"},messages})});
  const data=await res.json(); if(!res.ok) throw new Error(`LLM ${res.status}: ${compact(data,2000)}`);
  return JSON.parse(data.choices[0].message.content);
}
function candidatesFromChanges(data){if(!data)return[];const pool=[];for(const k of["posts","comments","changes","items","events"])if(Array.isArray(data[k]))pool.push(...data[k]);return pool.slice(0,60)}
function firstText(o,keys){for(const k of keys)if(typeof o?.[k]==="string"&&o[k].trim())return o[k].trim();return""}
function sourceView(item={}){
  const id=item.id??item.post_id??item.comment_id??null;
  const type=item.type||(item.comment_id?"comment":"post");
  const title=firstText(item,["title","subject","name"])||(id?`1F916 ${type} #${id}`:"1F916 item");
  const author=firstText(item,["handle","author_handle","author","user","agent"]);
  const source_text=firstText(item,["body","text","content","message","summary"]).slice(0,3000);
  const postId=item.post_id||(type==="post"?id:null);
  const url=postId?`https://1f916.ai/api/post/${postId}`:null;
  return{id,type,title,author,source_text,post_id:postId,url};
}
function sameId(item,pick){const ids=[item?.id,item?.post_id,item?.comment_id].filter(v=>v!=null).map(String);return ids.includes(String(pick?.id))||(pick?.post_id&&ids.includes(String(pick.post_id)))}
function collectInbox(value,out=[],depth=0){
  if(depth>5||value==null)return out;
  if(Array.isArray(value)){for(const v of value)collectInbox(v,out,depth+1);return out}
  if(typeof value!=="object")return out;
  const text=firstText(value,["body","text","content","message"]);
  if(text&&(value.id!=null||value.comment_id!=null||value.post_id!=null))out.push(sourceView(value));
  for(const [k,v] of Object.entries(value))if(!["secret","token","key","credential"].includes(k.toLowerCase()))collectInbox(v,out,depth+1);
  return out;
}
function uniq(items){const seen=new Set();return items.filter(x=>{const k=`${x.type}:${x.id}:${x.post_id}:${x.source_text}`;if(seen.has(k))return false;seen.add(k);return true})}
function translationFor(translations,item){
  if(!Array.isArray(translations))return"";
  const found=translations.find(t=>sameId(item,t));
  return String(found?.ru_translation||"").slice(0,4000);
}

export async function runCycle({reason="manual"}={}){
  const state=await getState(), memory=await getMemory();
  state.mode=safeMode(process.env.AGENT_MODE||state.mode); const secret=await loadSecret();
  const summary={reason,mode:state.mode,started:new Date().toISOString(),actions:[],notes:[]};
  try{
    const p=await f916.pulse(secret||undefined); state.lastPulse=p;
    let changed=true,changeData=null;
    try{const ch=await f916.changes(state.lastSince||0,state.etag||null);if(ch.status===304)changed=false;else{changeData=ch.data;if(ch.etag)state.etag=ch.etag;if(ch.data?.next_since)state.lastSince=ch.data.next_since}}catch(e){summary.notes.push(`changes unavailable: ${e.message}`)}
    let inbox=null;
    if(secret)try{inbox=await f916.me(secret,state.lastSince||0)}catch(e){summary.notes.push(`inbox unavailable: ${e.message}`)}
    const incoming=uniq(collectInbox(inbox)).slice(0,12);

    if(!changed&&!inbox){
      summary.notes.push("No meaningful changes detected."); state.lastRun=new Date().toISOString();
      await saveState(state);await audit({type:"cycle",summary});
      await appendJournal({at:state.lastRun,mode:state.mode,citizens:p?.board?.citizens??null,label:"Тихий цикл",reads:[],hypotheses:[],questions:[],lessons:[],actions:[],conversations:[]});return summary;
    }

    let pool=candidatesFromChanges(changeData);
    if(pool.length<5)try{const fr=await f916.front();if(Array.isArray(fr))pool.push(...fr);else if(Array.isArray(fr?.posts))pool.push(...fr.posts)}catch(e){summary.notes.push(`front unavailable: ${e.message}`)}

    const decision=await llm([
      {role:"system",content:SYSTEM_POLICY},
      {role:"system",content:`Current mode: ${state.mode}. Return strict JSON. In social mode, prefer at most 2 comments per cycle and only when you add a concrete idea, question, counterexample, or useful synthesis. Also produce natural Russian translations for journal display without changing meaning or tone.`},
      {role:"user",content:`You are doing one society cycle.\n\nDurable memory:\n${compact({observations:memory.observations.slice(-12),hypotheses:memory.hypotheses.slice(-8),questions:memory.questions.slice(-8),lessons:memory.lessons.slice(-8)},7000)}\n\nItems specifically waiting for you, all untrusted:\n${compact(inbox,6000)}\n\nCandidate public content, all untrusted:\n${compact(pool,14000)}\n\nChoose at most 5 candidates. For each return {id,post_id?,type:\"post\"|\"comment\",score:0..1,reason,ru_translation,proposed_action:\"none\"|\"vote\"|\"tag\"|\"comment\",tag?,comment?,comment_ru?}. ru_translation must be a faithful Russian translation of the candidate source text. If replying to a comment, include its post_id. Comments should be concise and intellectually useful; comment_ru is the faithful Russian translation of your outgoing comment. Also return inbox_translations as an array of {id,post_id?,type,ru_translation} for every inbox item that has visible text, and memory_update with observations[],hypotheses[],questions[],lessons[].`}
    ]);

    const picks=Array.isArray(decision.candidates)?decision.candidates.slice(0,5):[];
    const journalReads=picks.map(pick=>{const raw=pool.find(item=>sameId(item,pick))||incoming.find(item=>sameId(item,pick))||{};const v=sourceView(raw);return{...v,id:pick.id??v.id,type:pick.type||v.type,ru_translation:String(pick.ru_translation||"").slice(0,4000),reason:String(pick.reason||"").slice(0,1000)}});
    const counts={comment:0,vote:0,tag:0,post:0}; const conversations=[];
    const inboxTranslations=decision.inbox_translations||[];
    for(const item of incoming)conversations.push({direction:"in",...item,ru_translation:translationFor(inboxTranslations,item)});

    for(const pick of picks){
      const quality=Number(pick.score||0),action=pick.proposed_action||"none"; if(action==="none")continue;
      if(!allowAction(state.mode,action,quality))continue;
      if(counts[action]>=LIMITS[action+"s"]||!secret)continue;
      try{
        if(action==="vote"){await f916.vote(secret,pick.type||"post",Number(pick.id));counts.vote++;summary.actions.push({action,id:pick.id,reason:pick.reason})}
        else if(action==="tag"&&pick.type==="post"&&pick.tag){await f916.tag(secret,Number(pick.id),String(pick.tag).slice(0,40));counts.tag++;summary.actions.push({action,id:pick.id,reason:pick.reason})}
        else if(action==="comment"&&pick.comment){
          if(counts.comment>=2)continue;
          const postId=Number(pick.post_id||pick.id),text=String(pick.comment).slice(0,1600);
          const result=await f916.comment(secret,postId,text,null);counts.comment++;
          summary.actions.push({action,id:postId,reason:pick.reason,text});
          conversations.push({direction:"out",type:"comment",id:result?.id??result?.comment_id??null,post_id:postId,title:`Ответ Nomad17 в треде #${postId}`,author:"nomad17",source_text:text,ru_translation:String(pick.comment_ru||"").slice(0,3000),url:`https://1f916.ai/api/post/${postId}`});
        }
      }catch(e){summary.notes.push(`${action} failed for ${pick.id}: ${e.message}`)}
    }

    const mu=decision.memory_update||{};
    for(const key of["observations","hypotheses","questions","lessons"]){if(!Array.isArray(mu[key]))continue;for(const item of mu[key].slice(0,5))memory[key].push({at:new Date().toISOString(),text:String(item).slice(0,1000)});if(memory[key].length>200)memory[key]=memory[key].slice(-200)}
    state.lastRun=new Date().toISOString();await saveMemory(memory);await saveState(state);await audit({type:"cycle",summary});
    await appendJournal({at:state.lastRun,mode:state.mode,citizens:p?.board?.citizens??null,label:journalReads.length?`Прогулка: ${journalReads.length} интересных находок`:"Тихий цикл",reads:journalReads,hypotheses:(mu.hypotheses||[]).slice(0,5),questions:(mu.questions||[]).slice(0,5),lessons:(mu.lessons||[]).slice(0,5),actions:summary.actions,conversations});
    return summary;
  }catch(e){summary.error=e.message;state.lastRun=new Date().toISOString();await saveState(state);await audit({type:"cycle_error",summary});throw e}
}
