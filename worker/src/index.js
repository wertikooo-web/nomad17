const ALLOWED_ORIGIN = "https://wertikooo-web.github.io";
const OWNER = "wertikooo-web";
const REPO = "nomad17";
const WORKFLOW = "nomad17.yml";
const MIN_GAP_MS = 60_000;

function json(body, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "access-control-allow-origin": ALLOWED_ORIGIN,
      "access-control-allow-methods": "POST, OPTIONS, GET",
      "access-control-allow-headers": "content-type",
      "vary": "Origin",
      ...extraHeaders,
    },
  });
}

function sameSecret(a = "", b = "") {
  const aa = new TextEncoder().encode(String(a));
  const bb = new TextEncoder().encode(String(b));
  if (aa.length !== bb.length) return false;
  let diff = 0;
  for (let i = 0; i < aa.length; i++) diff |= aa[i] ^ bb[i];
  return diff === 0;
}

async function github(env, path, init = {}) {
  return fetch(`https://api.github.com${path}`, {
    ...init,
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${env.GH_TOKEN}`,
      "x-github-api-version": "2022-11-28",
      "user-agent": "nomad17-launcher-worker",
      ...(init.headers || {}),
    },
  });
}

async function latestRun(env) {
  const r = await github(env, `/repos/${OWNER}/${REPO}/actions/workflows/${WORKFLOW}/runs?per_page=1`);
  if (!r.ok) throw new Error(`GitHub runs lookup failed: ${r.status}`);
  const data = await r.json();
  return data.workflow_runs?.[0] || null;
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin") || "";
    if (request.method === "OPTIONS") {
      if (origin !== ALLOWED_ORIGIN) return json({ ok: false, error: "Origin denied" }, 403);
      return json({ ok: true });
    }

    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/health") {
      return json({ ok: true, service: "nomad17-launcher", min_gap_seconds: 60 });
    }

    if (request.method !== "POST" || url.pathname !== "/run") {
      return json({ ok: false, error: "Not found" }, 404);
    }
    if (origin !== ALLOWED_ORIGIN) return json({ ok: false, error: "Origin denied" }, 403);
    if (!env.GH_TOKEN || !env.RUN_PASSWORD) return json({ ok: false, error: "Worker secrets are not configured" }, 503);

    let body;
    try { body = await request.json(); }
    catch { return json({ ok: false, error: "Bad JSON" }, 400); }

    if (!sameSecret(body?.password, env.RUN_PASSWORD)) {
      return json({ ok: false, error: "Неверная фраза" }, 401);
    }

    try {
      const latest = await latestRun(env);
      if (latest?.created_at) {
        const age = Date.now() - Date.parse(latest.created_at);
        if (age >= 0 && age < MIN_GAP_MS) {
          const wait = Math.max(1, Math.ceil((MIN_GAP_MS - age) / 1000));
          return json({ ok: false, error: `Nomad17 недавно запускался. Подожди ${wait} сек.`, retry_after: wait }, 429, { "retry-after": String(wait) });
        }
      }

      const r = await github(env, `/repos/${OWNER}/${REPO}/actions/workflows/${WORKFLOW}/dispatches`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ref: "main" }),
      });

      if (r.status !== 204) {
        const detail = await r.text();
        return json({ ok: false, error: `GitHub отказал в запуске (${r.status})`, detail: detail.slice(0, 500) }, 502);
      }
      return json({ ok: true, message: "Nomad17 проснулся" });
    } catch (e) {
      return json({ ok: false, error: e.message || "Launcher error" }, 502);
    }
  },
};
