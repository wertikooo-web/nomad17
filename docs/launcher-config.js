window.NOMAD17_RUN_ENDPOINT = "https://nomad17-run.wertikooo.workers.dev";

(() => {
  const nativeFetch = window.fetch.bind(window);
  const workerBase = window.NOMAD17_RUN_ENDPOINT.replace(/\/$/, "");
  const runsUrl = "https://api.github.com/repos/wertikooo-web/nomad17/actions/workflows/nomad17.yml/runs?per_page=10";

  async function githubStatus(statusUrl) {
    try {
      const requested = new URL(statusUrl, location.href);
      const afterRaw = requested.searchParams.get("after");
      const after = afterRaw ? Date.parse(afterRaw) - 5000 : 0;

      const rr = await nativeFetch(runsUrl, {
        headers: { Accept: "application/vnd.github+json" },
        cache: "no-store"
      });
      if (!rr.ok) throw new Error(`GitHub status ${rr.status}`);
      const data = await rr.json();
      const all = data.workflow_runs || [];
      const run = after ? all.find(r => Date.parse(r.created_at) >= after) : all[0];

      if (!run) {
        return new Response(JSON.stringify({ ok: true, found: false }), {
          status: 200,
          headers: { "content-type": "application/json" }
        });
      }

      let job = null;
      if (run.id) {
        const jr = await nativeFetch(`https://api.github.com/repos/wertikooo-web/nomad17/actions/runs/${run.id}/jobs?per_page=10`, {
          headers: { Accept: "application/vnd.github+json" },
          cache: "no-store"
        });
        if (jr.ok) {
          const jd = await jr.json();
          const first = (jd.jobs || [])[0] || null;
          if (first) {
            const steps = first.steps || [];
            const active = steps.find(s => s.status === "in_progress") || [...steps].reverse().find(s => s.status === "completed") || null;
            job = {
              job_status: first.status,
              job_conclusion: first.conclusion,
              current_step: active?.name || null,
              steps: steps.map(s => ({ name: s.name, status: s.status, conclusion: s.conclusion }))
            };
          }
        }
      }

      return new Response(JSON.stringify({
        ok: true,
        found: true,
        run: {
          id: run.id,
          status: run.status,
          conclusion: run.conclusion,
          created_at: run.created_at,
          run_started_at: run.run_started_at,
          updated_at: run.updated_at,
          html_url: run.html_url,
          event: run.event,
          attempt: run.run_attempt
        },
        job
      }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    } catch (error) {
      return new Response(JSON.stringify({ ok: false, error: error.message || "GitHub status error" }), {
        status: 502,
        headers: { "content-type": "application/json" }
      });
    }
  }

  window.fetch = function(input, init) {
    const url = typeof input === "string" ? input : input?.url || "";
    if (url.startsWith(workerBase + "/status")) return githubStatus(url);
    return nativeFetch(input, init);
  };
})();

window.addEventListener("DOMContentLoaded", () => {
  const password = document.getElementById("runPassword");
  if (!password) return;

  password.setAttribute("autocomplete", "new-password");
  password.value = "";

  const clearPassword = () => {
    password.value = "";
    setTimeout(() => {
      password.value = "";
      password.focus();
    }, 30);
  };

  document.getElementById("runNow")?.addEventListener("click", clearPassword, true);
  document.getElementById("missionBtn")?.addEventListener("click", clearPassword, true);
  document.getElementById("cancelRun")?.addEventListener("click", () => { password.value = ""; });
});
