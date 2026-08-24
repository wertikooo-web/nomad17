import fs from "node:fs/promises";
import path from "node:path";

const DATA=path.resolve("data"),DOCS=path.resolve("docs");
async function readJsonAt(base,name,fallback){try{return JSON.parse(await fs.readFile(path.join(base,name),"utf8"))}catch{return fallback}}
async function writeJsonAt(base,name,value){await fs.mkdir(base,{recursive:true});const tmp=path.join(base,`${name}.tmp`);await fs.writeFile(tmp,JSON.stringify(value,null,2));await fs.rename(tmp,path.join(base,name))}
async function readJson(name,fallback){return readJsonAt(DATA,name,fallback)}async function writeJson(name,value){return writeJsonAt(DATA,name,value)}
export async function getState(){return readJson("state.json",{lastSince:0,etag:null,lastRun:null,lastPulse:null,mode:process.env.AGENT_MODE||"observe",scheduler:false,pending:[]})}export async function saveState(state){return writeJson("state.json",state)}
export async function getMemory(){const m=await readJson("memory.json",{});return{observations:Array.isArray(m.observations)?m.observations:[],agents:m.agents&&typeof m.agents==="object"?m.agents:{},hypotheses:Array.isArray(m.hypotheses)?m.hypotheses:[],questions:Array.isArray(m.questions)?m.questions:[],lessons:Array.isArray(m.lessons)?m.lessons:[],interests:Array.isArray(m.interests)?m.interests:[],open_loops:Array.isArray(m.open_loops)?m.open_loops:[],relationships:m.relationships&&typeof m.relationships==="object"?m.relationships:{},curiosity_log:Array.isArray(m.curiosity_log)?m.curiosity_log:[]}}
export async function saveMemory(memory){return writeJson("memory.json",memory)}
export async function audit(event){const log=await readJson("audit.json",[]);log.unshift({at:new Date().toISOString(),...event});if(log.length>500)log.length=500;await writeJson("audit.json",log)}
export async function appendJournal(entry){const journal=await readJsonAt(DOCS,"journal.json",{updated_at:null,mode:"observe",citizens:null,cycles:[]});journal.updated_at=new Date().toISOString();journal.mode=entry.mode||journal.mode;if(entry.citizens!=null)journal.citizens=entry.citizens;journal.cycles.unshift(entry);if(journal.cycles.length>120)journal.cycles.length=120;await writeJsonAt(DOCS,"journal.json",journal)}
export async function loadSecret(){return process.env.F916_SECRET||null}
