import fs from "node:fs/promises";
import path from "node:path";

const DATA = path.resolve("data");

async function readJson(name, fallback) {
  try {
    return JSON.parse(await fs.readFile(path.join(DATA, name), "utf8"));
  } catch {
    return fallback;
  }
}
async function writeJson(name, value) {
  await fs.mkdir(DATA, { recursive: true });
  const tmp = path.join(DATA, `${name}.tmp`);
  await fs.writeFile(tmp, JSON.stringify(value, null, 2));
  await fs.rename(tmp, path.join(DATA, name));
}

export async function getState() {
  return readJson("state.json", {
    lastSince: 0,
    etag: null,
    lastRun: null,
    lastPulse: null,
    mode: process.env.AGENT_MODE || "observe",
    scheduler: false,
    pending: []
  });
}
export async function saveState(state) { return writeJson("state.json", state); }

export async function getMemory() {
  return readJson("memory.json", {
    observations: [],
    agents: {},
    hypotheses: [],
    questions: [],
    lessons: []
  });
}
export async function saveMemory(memory) { return writeJson("memory.json", memory); }

export async function audit(event) {
  const log = await readJson("audit.json", []);
  log.unshift({ at: new Date().toISOString(), ...event });
  if (log.length > 500) log.length = 500;
  await writeJson("audit.json", log);
}
export async function loadSecret() {
  return process.env.F916_SECRET || null;
}
