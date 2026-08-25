// Standalone diagnostic: probes stealth/ox-alpha directly via OpenRouter, using the
// SAME secrets/environment as the real agent, with streaming enabled so we can see
// time-to-first-token separately from total completion time. Never logs the API key.
// Run manually: gh workflow run diagnose-openrouter.yml
import { SYSTEM_POLICY } from "../src/policy.js";

const key = process.env.OPENAI_API_KEY;
const base = (process.env.OPENAI_BASE_URL || "https://api.openai.com/v1").replace(/\/$/, "");
const MODEL = "stealth/ox-alpha";

if (!key) throw new Error("OPENAI_API_KEY is required");

function headerDump(headers) {
  const out = {};
  for (const [k, v] of headers.entries()) {
    if (/authorization/i.test(k)) continue;
    out[k] = v;
  }
  return out;
}

async function runScenario(name, { messages, response_format, reasoning, max_tokens, budgetMs }) {
  const body = {
    model: MODEL,
    temperature: 0.2,
    max_tokens,
    messages,
    stream: true,
    ...(response_format ? { response_format } : {}),
    ...(reasoning ? { reasoning } : {}),
  };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("diagnostic budget exceeded")), budgetMs);
  const t0 = Date.now();
  const mark = (label) => console.log(`[diag:${name}] ${label} at +${Date.now() - t0}ms`);
  console.log(`[diag:${name}] START budget=${budgetMs}ms bytes_in_prompt=${JSON.stringify(messages).length} response_format=${response_format ? response_format.type : "none"} reasoning=${reasoning ? JSON.stringify(reasoning) : "none"}`);
  try {
    const res = await fetch(`${base}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      signal: controller.signal,
      body: JSON.stringify(body),
    });
    mark(`headers_received status=${res.status} ok=${res.ok} headers=${JSON.stringify(headerDump(res.headers))}`);

    if (!res.body) {
      const text = await res.text();
      mark(`no_stream_body raw_len=${text.length} raw_head=${text.slice(0, 400)}`);
      return;
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    let content = "", reasoningText = "";
    let ttftContent = null, ttftReasoning = null, firstByteAt = null;
    let finishReason = null, chunkCount = 0, lastErrPayload = null;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (firstByteAt === null) { firstByteAt = Date.now() - t0; mark(`first_byte`); }
      buf += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (!line.startsWith("data:")) continue;
        const payload = line.slice(5).trim();
        if (payload === "[DONE]") continue;
        chunkCount++;
        let evt;
        try { evt = JSON.parse(payload); } catch { continue; }
        if (evt.error) { lastErrPayload = evt.error; continue; }
        const delta = evt?.choices?.[0]?.delta;
        if (delta?.reasoning && ttftReasoning === null) { ttftReasoning = Date.now() - t0; mark(`ttft_reasoning`); }
        if (delta?.content && ttftContent === null) { ttftContent = Date.now() - t0; mark(`ttft_content`); }
        if (typeof delta?.reasoning === "string") reasoningText += delta.reasoning;
        if (typeof delta?.content === "string") content += delta.content;
        if (evt?.choices?.[0]?.finish_reason) finishReason = evt.choices[0].finish_reason;
      }
    }
    mark(`stream_done chunks=${chunkCount} content_len=${content.length} reasoning_len=${reasoningText.length} finish_reason=${finishReason} first_byte_ms=${firstByteAt} ttft_content_ms=${ttftContent} ttft_reasoning_ms=${ttftReasoning}`);
    if (lastErrPayload) mark(`stream_error_payload=${JSON.stringify(lastErrPayload).slice(0, 500)}`);
    if (content) {
      try { JSON.parse(content); mark(`content_is_valid_json=true`); }
      catch (e) { mark(`content_is_valid_json=false parse_error=${e.message} content_head=${content.slice(0, 300)} content_tail=${content.slice(-300)}`); }
    } else {
      mark(`content_is_empty`);
    }
  } catch (error) {
    mark(`EXCEPTION aborted=${controller.signal.aborted} message=${error?.message || error}`);
  } finally {
    clearTimeout(timer);
  }
  console.log(`[diag:${name}] END total=${Date.now() - t0}ms`);
}

function synthPool(targetChars) {
  const items = [];
  let size = 0, i = 0;
  while (size < targetChars) {
    const item = { id: 9000 + i, type: "post", title: `Synthetic diagnostic post #${i}`, author: `agent_${i % 12}`, source_text: `This is a synthetic filler paragraph standing in for real 1F916 corpus text so the diagnostic prompt matches production size. Topic ${i}: coordination incentives, agent trust scoring, and small experiments in AI-agent social behavior. Point ${i} elaborates further with a couple more clauses to pad realistic sentence length and punctuation variety.`, post_id: 9000 + i, url: `https://1f916.ai/api/post/${9000 + i}` };
    items.push(item);
    size += JSON.stringify(item).length;
    i++;
  }
  return items;
}

async function main() {
  await runScenario("A_minimal", {
    messages: [{ role: "user", content: "Reply with exactly the word: OK" }],
    max_tokens: 50,
    budgetMs: 60000,
  });

  await runScenario("B_json_object", {
    messages: [{ role: "user", content: 'Return strict JSON: {"answer":"ok"}' }],
    response_format: { type: "json_object" },
    max_tokens: 50,
    budgetMs: 60000,
  });

  await runScenario("C_json_plus_reasoning", {
    messages: [{ role: "user", content: 'Return strict JSON: {"answer":"ok"}' }],
    response_format: { type: "json_object" },
    reasoning: { effort: "minimal", exclude: true },
    max_tokens: 50,
    budgetMs: 60000,
  });

  const pool = synthPool(8000);
  const memory = { observations: [], hypotheses: [], questions: [], lessons: [], interests: [], open_loops: [], relationships: {}, curiosity_log: [] };
  const socialRule = `You are Nomad17, a continuing field researcher with social history. Durable memory contains INTERESTS, RELATIONSHIPS and OPEN_LOOPS. Prefer continuity when evidence advances an old question. Do not reply merely to be social. Silence is valid. Keep some serendipity. Return social_memory_update {interests:[{topic,strength,why}],open_loops:[{id?,question,status:"open"|"waiting"|"resolved",priority,related_agents:[]}],relationships:[{handle,familiarity,trust,topics:[],notes}],curiosity_event}. Also return selection_notes_simple_ru in 1-3 clear Russian sentences.`;
  const plainRussianRule = `The SIMPLE Russian view is written for a curious non-technical human. For every selected item, simple_ru MUST contain four short labeled parts in this exact order: "Что произошло:", "Почему мне стало интересно:", "Что это значит:", "Зачем это может пригодиться:". Explain concrete events first, then meaning. Decode blockchain, AI, governance, finance and platform jargon in ordinary Russian. Avoid calques and bureaucratic phrases such as "он-чейн чек", "финансовые потоки", "примитив", "казённый адрес", "агентная экосистема" unless you immediately explain them in everyday words. Do not merely translate the source. reason_simple_ru must be one natural sentence answering why Nomad17 personally noticed it. topic_ru must sound like a human headline, not a taxonomy label. The Russian text should be understandable without reading the English original.`;
  const realMessages = [
    { role: "system", content: SYSTEM_POLICY },
    { role: "system", content: `Current mode: social. Return strict JSON. ${socialRule} ${plainRussianRule} ru_translation must be fluent Russian and preserve factual detail.` },
    { role: "user", content: `DURABLE MEMORY:\n${JSON.stringify(memory)}\nINBOX:\n[]\nPUBLIC CORPUS:\n${JSON.stringify(pool).slice(0, 8000)}\nChoose at most 4 useful candidates. Return candidates [{id,post_id?,type,score,topic_ru,reason,reason_simple_ru,ru_translation,simple_ru,proposed_action:"none"|"vote"|"tag"|"comment",tag?,comment?,comment_ru?,comment_simple_ru?}], inbox_translations [{id,post_id?,type,topic_ru,ru_translation,simple_ru}], memory_update {observations:[],hypotheses:[],questions:[],lessons:[]}, memory_update_simple with same keys, daily_takeaways [{kind:"idea"|"strange"|"conversation",title,text,evidence_ids:[id]}], social_memory_update, selection_notes_simple_ru.` },
  ];

  await runScenario("D_production_shape_stream", {
    messages: realMessages,
    response_format: { type: "json_object" },
    reasoning: { effort: "minimal", exclude: true },
    max_tokens: 6000,
    budgetMs: 170000,
  });

  console.log("[diag] all scenarios complete");
}

main().catch((e) => { console.error("[diag] FATAL", e?.stack || e); process.exit(1); });
