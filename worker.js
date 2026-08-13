/* =====================================================
   mynote_bot — V15.1 OPEN SOURCE (بدون دروازهٔ مبدأ)
===================================================== */
const VERSION = "V15.1-OPEN-2026-08-14";
const BALE_BASE = "https://tapi.bale.ai/bot";

function cfg(env) {
  return {
    dest: String(env.DEST_CHANNEL_ID || env.DESTINATION_CHAT_ID || env.TARGET_CHAT_ID || ""),
    admin: String(env.ADMIN_ID || ""),
    windowOn: String(env.SEND_WINDOW || "off") === "on",
    delaySec: Math.max(0, Number(env.SEND_DELAY_SEC || 0))
  };
}
function iranMinutes() {
  const d = new Date(Date.now() + 3.5 * 3600 * 1000);
  return d.getUTCHours() * 60 + d.getUTCMinutes();
}
function inWindow(c) {
  if (!c.windowOn) return true;
  const m = iranMinutes();
  return m >= 510 && m <= 1350;
}

async function bale(env, method, payload) {
  const token = env.BALE_BOT_TOKEN || env.BALE_TOKEN;
  if (!token) throw new Error("BALE_BOT_TOKEN missing");
  const res = await fetch(BALE_BASE + token + "/" + method, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
  const data = await res.json().catch(() => null);
  if (!res.ok || !data || data.ok !== true) {
    throw new Error("Bale " + method + ": " + ((data && data.description) || res.status));
  }
  return data.result;
}

async function sendOne(env, c, fromChat, messageId) {
  try {
    return await bale(env, "copyMessage", { chat_id: c.dest, from_chat_id: fromChat, message_id: messageId });
  } catch (e) {
    return await bale(env, "forwardMessage", { chat_id: c.dest, from_chat_id: fromChat, message_id: messageId });
  }
}

const Q = "q15:";
async function qPush(KV, item) { await KV.put(Q + item.id, JSON.stringify(item), { expirationTtl: 2592000 }); }
async function qDel(KV, key) { await KV.delete(key); }
async function qList(KV) {
  const list = await KV.list({ prefix: Q, limit: 200 });
  const items = [];
  for (const k of list.keys) {
    const v = await KV.get(k.name, "json");
    if (v) items.push(v);
  }
  return items.sort((a, b) => (a.at || 0) - (b.at || 0));
}
async function getStats(KV) {
  return (await KV.get("stats15", "json")) || { received: 0, sent: 0, failed: 0, lastSentAt: null, lastError: null };
}
async function saveStats(KV, s) { await KV.put("stats15", JSON.stringify(s), { expirationTtl: 2592000 }); }
function json(obj, status) {
  return new Response(JSON.stringify(obj), { status: status || 200, headers: { "Content-Type": "application/json" } });
}

async function onWebhook(request, env, KV) {
  const c = cfg(env);
  const body = await request.json().catch(() => null);
  if (!body) return json({ ok: false }, 400);

  const seenKey = body.update_id != null ? "seen15:" + body.update_id : null;
  if (seenKey && (await KV.get(seenKey))) return json({ ok: true, duplicate: true });

  const msg = body.channel_post;
  if (!msg) {
    console.log(JSON.stringify({ event: "NO_CHANNEL_POST", keys: Object.keys(body) }));
    return json({ ok: true, ignored: true });
  }

  // ضدلوپ: پست‌های خودِ کانال مقصد رو نادیده بگیر
  if (c.dest && String(msg.chat.id) === c.dest) {
    return json({ ok: true, ignored: true, reason: "dest_echo" });
  }
  console.log(JSON.stringify({ event: "RECEIVED", chatId: String(msg.chat.id), mid: msg.message_id }));

  const s = await getStats(KV);
  s.received += 1;
  await saveStats(KV, s);

  const item = {
    id: msg.chat.id + "-" + msg.message_id,
    from: String(msg.chat.id),
    mid: Number(msg.message_id),
    at: Date.now() + c.delaySec * 1000,
    retry: 0
  };

  let result = null;
  if (item.at <= Date.now() && inWindow(c)) {
    try {
      await sendOne(env, c, item.from, item.mid);
      s.sent += 1; s.lastSentAt = Date.now(); s.lastError = null;
      await saveStats(KV, s);
      result = { ok: true, sent: true };
      console.log(JSON.stringify({ event: "SENT_IMMEDIATE", mid: item.mid }));
    } catch (e) {
      s.lastError = e.message;
      await saveStats(KV, s);
      console.log(JSON.stringify({ event: "IMMEDIATE_FAIL", err: e.message }));
    }
  }
  if (!result) {
    await qPush(KV, item);
    result = { ok: true, queued: true };
    console.log(JSON.stringify({ event: "QUEUED", mid: item.mid }));
  }
  if (seenKey) await KV.put(seenKey, "1", { expirationTtl: 86400 });
  return json(result);
}

async function onCron(env, KV) {
  const c = cfg(env);
  const s = await getStats(KV);

  if (inWindow(c)) {
    const now = Date.now();
    const items = (await qList(KV)).filter(i => (i.at || 0) <= now);
    for (const it of items.slice(0, 10)) {
      try {
        await sendOne(env, c, it.from, it.mid);
        await qDel(KV, Q + it.id);
        s.sent += 1; s.lastSentAt = now; s.lastError = null;
        console.log(JSON.stringify({ event: "SENT_FROM_QUEUE", mid: it.mid }));
      } catch (e) {
        it.retry += 1;
        s.failed += 1; s.lastError = e.message;
        if (it.retry >= 6) {
          await qDel(KV, Q + it.id);
          await KV.put("dlq15:" + it.id, JSON.stringify(it), { expirationTtl: 2592000 });
          if (c.admin) bale(env, "sendMessage", { chat_id: c.admin, text: "☠️ ارسال ناموفق (۶ تلاش):\nپیام " + it.mid + "\n" + e.message }).catch(() => {});
        } else {
          it.at = now + Math.min(3600, 60 * it.retry) * 1000;
          await qPush(KV, it);
        }
      }
    }
  }

  const last = Number(await KV.get("report15") || 0);
  if (c.admin && Date.now() - last >= 3600 * 1000) {
    const q = await qList(KV);
    const txt = "📊 گزارش mynote_bot (V15.1)\n\n📥 دریافتی: " + s.received + "\n📤 ارسال موفق: " + s.sent + "\n❌ ناموفق: " + s.failed + "\n📦 صف: " + q.length + "\n\n" + (s.lastError ? "⚠️ آخرین خطا: " + s.lastError : "✅ بدون خطا");
    try {
      await bale(env, "sendMessage", { chat_id: c.admin, text: txt });
      await KV.put("report15", String(Date.now()), { expirationTtl: 2592000 });
    } catch (e) {}
  }
  await saveStats(KV, s);
}

export default {
  async fetch(request, env) {
    const KV = env.MYNOTE_KV || env.KV;
    const p = new URL(request.url).pathname;

    if (p === "/webhook" || p === "/telegram/webhook") {
      if (request.method !== "POST") return new Response("Method Not Allowed", { status: 405 });
      try {
        return await onWebhook(request, env, KV);
      } catch (e) {
        console.log(JSON.stringify({ event: "WEBHOOK_ERROR", err: e.message }));
        return json({ ok: false, error: e.message }, 500);
      }
    }
    if (p === "/health") return json({ ok: true, version: VERSION });
    const s = KV ? await getStats(KV) : {};
    return json({ ok: true, service: "mynote_bot", version: VERSION, stats: s });
  },

  async scheduled(controller, env) {
    const KV = env.MYNOTE_KV || env.KV;
    try { await onCron(env, KV); }
    catch (e) { console.log(JSON.stringify({ event: "CRON_ERROR", err: e.message })); }
  }
};