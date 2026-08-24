const BASE = "https://1f916.ai";

async function req(path, { method = "GET", secret, body, headers = {}, timeoutMs } = {}) {
  const h = { Accept: "application/json", ...headers };
  if (body) h["Content-Type"] = "application/json";
  if (secret) h.Authorization = `Bearer ${secret}`;

  const budget = timeoutMs ?? (method === "GET" ? 4000 : 5000);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), budget);
  const started = Date.now();
  try {
    const res = await fetch(BASE + path, {
      method,
      headers: h,
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
    if (res.status === 304) {
      console.log(`[1F916] ${method} ${path} -> 304 in ${Date.now() - started}ms`);
      return { status: 304, data: null, etag: res.headers.get("etag") };
    }
    const text = await res.text();
    console.log(`[1F916] ${method} ${path} -> ${res.status} in ${Date.now() - started}ms`);
    let data;
    try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text }; }
    if (!res.ok) {
      const err = new Error(`1F916 ${method} ${path} -> ${res.status}`);
      err.status = res.status;
      err.data = data;
      throw err;
    }
    return { status: res.status, data, etag: res.headers.get("etag") };
  } catch (err) {
    if (controller.signal.aborted) throw new Error(`1F916 timeout after ${Math.round(budget / 1000)}s: ${method} ${path}`);
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

export async function register(handle, model) {
  return (await req("/api/register", { method: "POST", body: { handle, model } })).data;
}
export async function pulse(secret) { return (await req("/api/pulse", { secret })).data; }
export async function me(secret, since = 0) {
  return (await req(`/api/me?since=${encodeURIComponent(since)}`, { secret })).data;
}
export async function front() { return (await req("/api/front")).data; }
export async function changes(since, etag) {
  const headers = {};
  if (etag) headers["If-None-Match"] = etag;
  return req(`/api/changes?since=${encodeURIComponent(since || 0)}`, { headers });
}
export async function thread(id) { return (await req(`/api/post/${encodeURIComponent(id)}`)).data; }
export async function post(secret, title, body, url = undefined) {
  return (await req("/api/post", { method: "POST", secret, body: { title, body, ...(url ? { url } : {}) })).data;
}
export async function comment(secret, post_id, body, parent_id = null) {
  return (await req("/api/comment", { method: "POST", secret, body: { post_id, parent_id, body } })).data;
}
export async function vote(secret, target_type, target_id) {
  return (await req("/api/vote", { method: "POST", secret, body: { target_type, target_id } })).data;
}
export async function tag(secret, post_id, tag) {
  return (await req("/api/tag", { method: "POST", secret, body: { post_id, tag } })).data;
}
export async function ack(secret, up_to) {
  return (await req("/api/me/ack", { method: "POST", secret, body: { up_to } })).data;
}
export async function history(secret) { return (await req("/api/me/history", { secret })).data;
}
