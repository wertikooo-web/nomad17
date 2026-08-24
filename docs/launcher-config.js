window.NOMAD17_RUN_ENDPOINT = "https://nomad17-run.wertikooo.workers.dev";
try { localStorage.removeItem("nomad17-active-run"); } catch {}

(() => {
  const nativeFetch = window.fetch.bind(window);
  const workerBase = window.NOMAD17_RUN_ENDPOINT.replace(/\/$/, "");
  const pendingTranslation = "Перевод ещё готовится…";
  let statusCache = null;
  let statusCacheAt = 0;

  function normalizeJournal(journal) {
    for (const cycle of journal?.cycles || []) {
      for (const item of cycle.reads || []) {
        item.ru_translation = item.ru_translation || pendingTranslation;
        item.simple_ru = item.simple_ru || (item.ru_translation !== pendingTranslation ? item.ru_translation : pendingTranslation);
        item.reason_simple_ru = item.reason_simple_ru || "Пояснение ещё готовится…";
      }
      for (const msg of cycle.conversations || []) {
        msg.ru_translation = msg.ru_translation || pendingTranslation;
        msg.simple_ru = msg.simple_ru || (msg.ru_translation !== pendingTranslation ? msg.ru_translation : pendingTranslation);
      }
    }
    return journal;
  }

  function jsonResponse(data, status=200) {
    return new Response(JSON.stringify(data), { status, headers:{"content-type":"application/json","cache-control":"no-store"} });
  }

  async function journalFallback(statusUrl) {
    const requested = new URL(statusUrl, location.href);
    const afterRaw = requested.searchParams.get("after");
    const after = afterRaw ? Date.parse(afterRaw) : Date.now();
    const launch = JSON.parse(sessionStorage.getItem("nomad17-launch") || "null");
    try {
      const jr = await nativeFetch(`./journal.json?status=${Date.now()}`, {cache:"no-store"});
      const j = await jr.json();
      const updated = Date.parse(j.updated_at || 0);
      if (updated >= after - 2000) {
        return jsonResponse({ok:true,found:true,run:{status:"completed",conclusion:"success",updated_at:j.updated_at},job:{current_step:"Persist memory, journal and diagnostics"}});
      }
    } catch {}
    const age = Math.max(0, Date.now() - after);
    const deep = launch?.kind === "mission";
    const hardMs = deep ? 620000 : 140000;
    if (age > hardMs) {
      return jsonResponse({ok:true,found:true,run:{status:"completed",conclusion:"timed_out"},job:{current_step:"Runtime limit reached"}});
    }
    return jsonResponse({ok:true,found:true,run:{status:"in_progress",conclusion:null},job:{current_step:"Run one Nomad17 cycle"},fallback:true});
  }

  async function workerStatus(url) {
    if (statusCache && Date.now() - statusCacheAt < 10000) return statusCache.clone();
    try {
      const r = await nativeFetch(url, {cache:"no-store"});
      if (r.ok) {
        statusCache = r.clone(); statusCacheAt = Date.now();
        return r;
      }
      return journalFallback(url);
    } catch {
      return journalFallback(url);
    }
  }

  window.fetch = async function(input, init) {
    const url = typeof input === "string" ? input : input?.url || "";
    if (url.startsWith(workerBase + "/status")) return workerStatus(url);

    const response = await nativeFetch(input, init);
    if ((url === workerBase + "/run" || url === workerBase + "/mission") && response.ok) {
      try {
        const d = await response.clone().json();
        sessionStorage.setItem("nomad17-launch", JSON.stringify({kind:url.endsWith("/mission")?"mission":"run",accepted_at:d.accepted_at||new Date().toISOString()}));
        statusCache = null;
      } catch {}
    }
    if (url.includes("journal.json")) {
      try {
        const data = normalizeJournal(await response.clone().json());
        return jsonResponse(data, response.status);
      } catch {}
    }
    return response;
  };

  function esc(s){return String(s??"").replace(/[&<>\"]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;"}[c]))}
  function pct(x){return Math.round(Math.max(0,Math.min(1,Number(x)||0))*100)}
  async function renderMind(){
    try{
      const r=await nativeFetch(`./journal.json?mind=${Date.now()}`,{cache:"no-store"}),j=await r.json();
      const c=(j.cycles||[]).find(x=>(x.interests_snapshot||[]).length||(x.open_loops_snapshot||[]).length||(x.relationships_snapshot||[]).length||x.selection_notes_simple_ru);
      const host=document.getElementById("nomad17Mind"); if(!host)return;
      if(!c){host.innerHTML='<div class="mind-empty">Пока пусто. После нового успешного цикла здесь появятся интересы, вопросы и знакомые агенты.</div>';return}
      const interests=(c.interests_snapshot||[]).slice(0,6),loops=(c.open_loops_snapshot||[]).slice(0,5),rels=(c.relationships_snapshot||[]).slice(0,5);
      host.innerHTML=`${c.selection_notes_simple_ru?`<div class="mind-why"><b>Почему сегодня пошёл туда:</b> ${esc(c.selection_notes_simple_ru)}</div>`:""}<div class="mind-grid"><div class="mind-card"><div class="mind-title">Что его сейчас цепляет</div>${interests.length?interests.map(x=>`<div class="mind-interest"><div><b>${esc(x.topic||x.name||x.text)}</b><span>${pct(x.strength)}%</span></div><div class="mind-meter"><i style="width:${pct(x.strength)}%"></i></div>${x.why?`<small>${esc(x.why)}</small>`:""}</div>`).join(""):'<div class="mind-muted">Интересы ещё не сформировались.</div>'}</div><div class="mind-card"><div class="mind-title">Что осталось недокопанным</div>${loops.length?loops.map(x=>`<div class="mind-loop"><b>${esc(x.question||x.text)}</b><small>приоритет ${pct(x.priority)}%</small></div>`).join(""):'<div class="mind-muted">Незакрытых вопросов пока нет.</div>'}</div><div class="mind-card"><div class="mind-title">Кого он уже знает</div>${rels.length?rels.map(x=>`<div class="mind-person"><b>@${esc(x.handle)}</b><span>знакомство ${pct(x.familiarity)}%</span>${(x.topics||[]).length?`<small>${esc(x.topics.slice(-3).join(' · '))}</small>`:""}</div>`).join(""):'<div class="mind-muted">Устойчивых знакомых пока нет.</div>'}</div></div>`;
    }catch(e){const host=document.getElementById("nomad17Mind");if(host)host.innerHTML='<div class="mind-muted">Не удалось загрузить состояние памяти.</div>'}
  }

  window.addEventListener("DOMContentLoaded",()=>{
    const style=document.createElement("style");style.textContent=`.mind-shell{margin-top:34px}.mind-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:13px}.mind-card{border:1px solid #27303d;background:#10151dcc;border-radius:18px;padding:17px;min-width:0}.mind-title{font-weight:800;margin-bottom:13px}.mind-why{border:1px solid #394c33;background:#10170e;border-radius:14px;padding:14px 16px;margin-bottom:13px}.mind-interest,.mind-loop,.mind-person{padding:10px 0;border-bottom:1px solid #222b35}.mind-interest>div:first-child,.mind-person{display:flex;justify-content:space-between;gap:10px;flex-wrap:wrap}.mind-meter{height:6px;background:#1b2520;border-radius:99px;overflow:hidden;margin:7px 0}.mind-meter i{display:block;height:100%;background:#b9ff66}.mind-card small,.mind-muted,.mind-empty{display:block;color:#8f9aaa;font-size:12px;margin-top:5px}.mind-person small{width:100%}@media(max-width:780px){.mind-grid{grid-template-columns:1fr}}`;document.head.appendChild(style);
    const conversations=[...document.querySelectorAll("section")].find(s=>s.querySelector("h2")?.textContent.includes("Интересные разговоры"));
    const sec=document.createElement("section");sec.className="section mind-shell";sec.innerHTML='<div class="eyebrow">Mind</div><h2>Что сейчас в голове у Nomad17</h2><div id="nomad17Mind"><div class="mind-muted">Загружаю память…</div></div>';
    if(conversations)conversations.before(sec);else document.querySelector("main")?.appendChild(sec);
    renderMind();setInterval(renderMind,30000);
  });
})();

window.addEventListener("DOMContentLoaded", () => {
  const password = document.getElementById("runPassword");
  if (!password) return;
  password.setAttribute("autocomplete", "new-password");
  password.value = "";
  const clearPassword = () => { password.value = ""; setTimeout(() => { password.value = ""; password.focus(); }, 30); };
  document.getElementById("runNow")?.addEventListener("click", clearPassword, true);
  document.getElementById("missionBtn")?.addEventListener("click", clearPassword, true);
  document.getElementById("cancelRun")?.addEventListener("click", () => { password.value = ""; });
});
