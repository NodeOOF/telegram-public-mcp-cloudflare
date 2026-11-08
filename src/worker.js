const PROTOCOL_VERSION = "2025-03-26";
const SERVER_INFO = { name: "telegram-public-mcp-cf", version: "1.5.0" };
const MAX_LIMIT = 100;
const MAX_MESSAGE_LEN = 3800;
const PUSH_MAX_PER_MSG = 5;

const TOOL_DEFS = [
  { name: "get_channel_info", description: "Get public Telegram channel info.", inputSchema: { type: "object", properties: { channel: { type: "string" } }, required: ["channel"], additionalProperties: false } },
  { name: "get_latest_posts", description: "Get latest public posts.", inputSchema: { type: "object", properties: { channel: { type: "string" }, limit: { type: "integer" }, before_post_id: { type: "integer" }, before_time: { type: "string" } }, required: ["channel"], additionalProperties: false } },
  { name: "search_posts", description: "Search public posts.", inputSchema: { type: "object", properties: { channel: { type: "string" }, query: { type: "string" }, limit: { type: "integer" } }, required: ["channel", "query"], additionalProperties: false } },
];

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === "GET" && (url.pathname === "/" || url.pathname === "/healthz" || url.pathname === "/health")) {
      return json({ ok: true, service: SERVER_INFO.name, version: SERVER_INFO.version, hasBotToken: !!env.BOT_TOKEN, hasChatId: !!env.MY_CHAT_ID, hasKV: !!env.SEEN_POSTS });
    }
    if (url.pathname === "/debug" && request.method === "GET") return await debugEndpoint(env);
    if (url.pathname === "/api/test-message" && request.method === "GET") return await testMessageEndpoint(env);
    if (url.pathname === "/api/force-start" && request.method === "GET") return await forceStartEndpoint(env, url.searchParams.get("chat_id"));
    if (url.pathname === "/api/config-reset" && request.method === "GET") { await env.SEEN_POSTS.delete("config"); return json({ ok: true, message: "Config cleared. Send /start." }); }

    if (url.pathname === "/webhook" && request.method === "POST") {
      console.log("[WEBHOOK] Received");
      let update; try { update = await request.json(); } catch { return json({ ok: false, error: "invalid_json" }); }
      let error = null;
      try { await handleUpdate(env, update); } catch (err) { error = err?.message || String(err); console.error("[WEBHOOK ERROR]", error, err?.stack); }
      return json({ ok: !error, error });
    }

    if (url.pathname !== "/mcp") return json({ error: "not found" }, 404);
    if (request.method !== "POST") return json({ error: "method not allowed" }, 405);
    let req; try { req = await request.json(); } catch { return rpcError(null, -32700, "Parse error"); }
    const base = { jsonrpc: "2.0", id: req.id ?? null };
    try {
      if (req.method === "initialize") return json({ ...base, result: { protocolVersion: PROTOCOL_VERSION, capabilities: { tools: { listChanged: false } }, serverInfo: SERVER_INFO } });
      if (req.method === "tools/list") return json({ ...base, result: { tools: TOOL_DEFS } });
      if (req.method === "notifications/initialized") return new Response(null, { status: 204 });
      if (req.method === "tools/call") return json({ ...base, result: { content: [{ type: "text", text: JSON.stringify(await callTool(env, req.params?.name, req.params?.arguments || {}), null, 2) }] } });
      return rpcError(req.id ?? null, -32601, "Method not found");
    } catch (err) { return rpcError(req.id ?? null, -32603, err?.message || String(err)); }
  },
  async scheduled(event, env, ctx) { ctx.waitUntil(checkAndUpdate(env)); },
};

/* ============================================================
   DEBUG endpoints
   ============================================================ */

async function debugEndpoint(env) {
  const result = { version: SERVER_INFO.version, timestamp: new Date().toISOString(), env: {}, config: null, botInfo: null, errors: [] };
  result.env.hasBotToken = !!env.BOT_TOKEN;
  result.env.botTokenPreview = env.BOT_TOKEN ? `${env.BOT_TOKEN.slice(0, 10)}...` : null;
  result.env.hasChatId = !!env.MY_CHAT_ID;
  result.env.chatId = env.MY_CHAT_ID ? String(env.MY_CHAT_ID) : null;
  result.env.channelName = env.CHANNEL_NAME || null;
  result.env.hasKV = !!env.SEEN_POSTS;
  if (env.BOT_TOKEN) {
    try { const r = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/getMe`); const d = await r.json();
      if (d.ok) result.botInfo = { id: d.result.id, username: d.result.username }; else result.errors.push(`getMe failed: ${d.description}`);
    } catch (err) { result.errors.push(`getMe error: ${err.message}`); }
  }
  try { result.config = await getConfig(env); } catch (err) { result.errors.push(`getConfig error: ${err.message}`); }
  return json(result);
}

async function testMessageEndpoint(env) {
  if (!env.BOT_TOKEN) return json({ ok: false, error: "BOT_TOKEN missing" });
  const cfg = await getConfig(env);
  const chatId = cfg?.chatId || env.MY_CHAT_ID;
  if (!chatId) return json({ ok: false, error: "No chat ID" });
  try {
    const res = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/sendMessage`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text: "🧪 پیام تست", parse_mode: "HTML" }),
    });
    return json({ ok: true, telegram: await res.json() });
  } catch (err) { return json({ ok: false, error: err.message }); }
}

async function forceStartEndpoint(env, chatIdParam) {
  if (!env.BOT_TOKEN) return json({ ok: false, error: "BOT_TOKEN missing" });
  let cfg = await getConfig(env);
  const chatId = chatIdParam ? parseInt(chatIdParam, 10) : (cfg?.chatId || env.MY_CHAT_ID);
  if (!chatId) return json({ ok: false, error: "No chat ID" });
  try {
    if (cfg) { cfg.messageId = null; cfg.chatId = chatId; await saveConfig(env, cfg); }
    await initFixedMessage(env, chatId);
    return json({ ok: true, message: "Force start attempted", chatId });
  } catch (err) { return json({ ok: false, error: err.message }); }
}

/* ============================================================
   Config
   ============================================================ */

function getTehranDate() {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Tehran", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
}

async function getConfig(env) {
  const raw = await env.SEEN_POSTS.get("config");
  if (!raw) return null;
  try {
    const cfg = JSON.parse(raw);
    if (cfg.channel && !cfg.channels) {
      cfg.channels = [{ name: cfg.channel, keywords: cfg.keywords || [], active: true }];
      delete cfg.channel; delete cfg.keywords;
    }
    if (!cfg.channels) cfg.channels = [];
    if (!cfg.pendingDeletes) cfg.pendingDeletes = [];
    if (!cfg.lastResetDate) cfg.lastResetDate = getTehranDate();
    if (!cfg.lastCheckTime) cfg.lastCheckTime = Date.now();
    if (cfg.pushEnabled === undefined) cfg.pushEnabled = true;
    return cfg;
  } catch { return null; }
}
async function saveConfig(env, cfg) { await env.SEEN_POSTS.put("config", JSON.stringify(cfg)); }

async function initFixedMessage(env, chatId) {
  console.log("[INIT] Starting for chat", chatId);
  if (!env.BOT_TOKEN) throw new Error("BOT_TOKEN is not set.");
  let cfg = await getConfig(env);
  if (cfg && cfg.messageId) {
    console.log("[INIT] Deleting old message", cfg.messageId);
    await deleteMessage(env, cfg.chatId, cfg.messageId);
  }
  if (!cfg) {
    cfg = {
      chatId, messageId: null, active: true,
      channels: [{ name: env.CHANNEL_NAME || "Akhbare_madrs", keywords: [], active: true }],
      viewMode: "single", createdAt: Date.now(),
      lastResetDate: getTehranDate(), lastCheckTime: Date.now(),
      pushEnabled: true, pendingDeletes: [],
    };
  } else {
    cfg.chatId = chatId;
    cfg.messageId = null;
  }
  await saveConfig(env, cfg);
  for (let attempt = 1; attempt <= 3; attempt++) {
    const ok = await createFixedMessage(env, cfg);
    if (ok) { console.log("[INIT] Dashboard created, messageId=", cfg.messageId); return; }
    console.log(`[INIT] Attempt ${attempt} failed`);
  }
  throw new Error("Failed to send dashboard after 3 attempts.");
}

async function createFixedMessage(env, cfg) {
  let posts = [], stats = {};
  try { const r = await getAllPostsFiltered(env, cfg); posts = r.posts; stats = r.stats; }
  catch (err) { console.error("[CREATE_FIXED]", err.message); }
  const text = buildDashboardText(cfg, posts, stats);
  const data = await sendTelegramRaw(env, cfg.chatId, text, buildKeyboard(cfg));
  if (!data.ok) { console.error("[CREATE_FIXED] failed:", JSON.stringify(data)); return false; }
  cfg.messageId = data.result.message_id;
  await saveConfig(env, cfg);
  await trackMessage(env, cfg.chatId, cfg.messageId);
  return true;
}

async function tryEditMessage(env, cfg, text, keyboard) {
  if (!cfg.messageId) return false;
  try {
    const res = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/editMessageText`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: cfg.chatId, message_id: cfg.messageId, text, parse_mode: "HTML", disable_web_page_preview: true, reply_markup: keyboard }),
    });
    const data = await res.json();
    if (data.ok) return true;
    if (data.description?.includes("message is not modified")) return true;
    if (data.description?.includes("not found") || data.description?.includes("MESSAGE_ID_INVALID")) {
      cfg.messageId = null; await saveConfig(env, cfg); return false;
    }
    if (data.description?.includes("can't parse entities")) {
      const r2 = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/editMessageText`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ chat_id: cfg.chatId, message_id: cfg.messageId, text: text.replace(/<[^>]+>/g, ""), disable_web_page_preview: true, reply_markup: keyboard }),
      });
      const d2 = await r2.json();
      return !!d2.ok;
    }
    console.error("[EDIT] failed:", JSON.stringify(data));
    return false;
  } catch (err) { console.error("[EDIT]", err.message); return false; }
}

/* ============================================================
   Filters
   ============================================================ */

function matchesChannelKeywords(post, ch) {
  if (!ch.keywords || ch.keywords.length === 0) return true;
  const haystack = ((post.text || "") + " " + (post.author || "")).toLowerCase();
  return ch.keywords.some(kw => haystack.includes(kw.toLowerCase()));
}

// آیا پست باید پوش بشه؟
// فقط اگر کانال فیلتر داشته باشه و پست مطابق باشه
function shouldPushPost(post, ch) {
  return ch.keywords && ch.keywords.length > 0 && matchesChannelKeywords(post, ch);
}

/* ============================================================
   Dashboard
   ============================================================ */

function buildDashboardText(cfg, posts, stats = {}) {
  const now = cfg.lastCheckTime ? new Date(cfg.lastCheckTime) : new Date();
  const timeStr = new Intl.DateTimeFormat("fa-IR", { timeZone: "Asia/Tehran", hour: "2-digit", minute: "2-digit", year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
  const statusIcon = cfg.active ? "🟢" : "🔴";
  const statusText = cfg.active ? "فعال" : "متوقف";
  const pushIcon = cfg.pushEnabled !== false ? "🔔" : "🔕";
  const pushText = cfg.pushEnabled !== false ? "روشن" : "خاموش";
  const channelList = cfg.channels.length > 0 ? cfg.channels.map(c => `@${c.name}`).join(" · ") : "<i>هیچ کانالی</i>";

  let body;
  if (cfg.viewMode === "list" && posts.length > 0) {
    const top = posts.slice(0, 5);
    body = "📋 <b>آخرین پست‌های مطابق فیلتر:</b>\n\n" + top.map((p, i) => {
      let txt = (p.text || "(بدون متن)").trim().slice(0, 200).replace(/\n+/g, " ");
      return `<b>${i + 1}.</b> از @${p.channelName}\n${escapeHtml(txt)}…\n<a href="${p.url}">مشاهده</a>`;
    }).join("\n\n");
  } else {
    const p = posts[0];
    if (!p) body = "📭 هنوز پستی مطابق فیلتر نیست.";
    else {
      let txt = (p.text || "(بدون متن)").trim();
      if (txt.length > 500) txt = txt.slice(0, 500) + "…";
      body = [
        `📝 <b>آخرین پست مطابق فیلتر</b> (از @${p.channelName}):`,
        "",
        escapeHtml(txt),
        "",
        `🔗 <a href="${p.url}">مشاهده</a>` + (p.views ? `  |  👁 ${escapeHtml(p.views)}` : ""),
        p.timestamp ? `🕐 ${escapeHtml(p.timestamp)}` : "",
      ].filter(Boolean).join("\n");
    }
  }

  const text = [
    `🎯 <b>رصد کانال‌ها</b>`,
    `📢 ${channelList}`,
    "",
    `وضعیت: ${statusIcon} <b>${statusText}</b>  |  ${pushIcon} پوش: <b>${pushText}</b>`,
    `⏱ آخرین بررسی: <code>${timeStr}</code>`,
    `📊 امروز: <b>${stats.todayCount || 0}</b> پست`,
    "",
    "━━━━━━━━━━━━━━━━━━",
    body,
    "━━━━━━━━━━━━━━━━━━",
  ].join("\n");

  return text.length > MAX_MESSAGE_LEN ? text.slice(0, MAX_MESSAGE_LEN - 3) + "..." : text;
}

function buildKeyboard(cfg) {
  const toggleLabel = cfg.active ? "🔴 توقف رصد" : "🟢 شروع رصد";
  const viewLabel = cfg.viewMode === "single" ? "📋 نمایش لیست" : "🎯 نمایش تکی";
  const pushLabel = cfg.pushEnabled !== false ? "🔕 خاموش پوش" : "🔔 روشن پوش";
  return {
    inline_keyboard: [
      [{ text: "🔄 بروزرسانی", callback_data: "refresh" }, { text: toggleLabel, callback_data: "toggle" }],
      [{ text: pushLabel, callback_data: "toggle_push" }, { text: viewLabel, callback_data: "toggle_view" }],
      [{ text: "📢 کانال‌ها", callback_data: "channels_menu" }, { text: "🟣 ریست", callback_data: "reset" }],
      [{ text: "❓ راهنما", callback_data: "help" }],
    ],
  };
}

function buildChannelsKeyboard(cfg) {
  const rows = [];
  for (let i = 0; i < cfg.channels.length; i++) {
    const ch = cfg.channels[i];
    const kw = (ch.keywords || []).length;
    const pushInfo = kw > 0 ? `🔔 ${kw}` : "🔕 0";
    rows.push([{ text: `${ch.active ? "🟢" : "🔴"} ${ch.name} (${pushInfo})`, callback_data: `ch_settings:${i}` }]);
  }
  if (cfg.channels.length === 0) rows.push([{ text: "— هنوز کانالی نیست —", callback_data: "noop" }]);
  rows.push([{ text: "➕ افزودن کانال", callback_data: "add_channel" }]);
  rows.push([{ text: "↩️ بازگشت", callback_data: "back" }]);
  return { inline_keyboard: rows };
}

function buildChannelSettingsText(cfg, idx) {
  const ch = cfg.channels[idx];
  if (!ch) return "کانال یافت نشد.";
  const kwList = (ch.keywords?.length > 0) ? ch.keywords.map((k, i) => `${i + 1}. <code>${escapeHtml(k)}</code>`).join("\n") : "<i>هیچ کلمه‌ای — همه پست‌ها در داشبورد (بدون پوش)</i>";
  const pushInfo = (ch.keywords?.length > 0) ? "🔔 پست‌های مطابق پوش می‌شوند" : "🔕 پوش ندارد (بدون فیلتر)";
  return [
    `📢 <b>کانال @${escapeHtml(ch.name)}</b>`,
    "",
    `وضعیت: ${ch.active ? "🟢 فعال" : "🔴 غیرفعال"}`,
    `${pushInfo}`,
    "",
    "🔍 <b>کلمات کلیدی:</b>",
    kwList,
    "",
    "با افزودن کلمه، پست‌های مطابق پوش می‌شوند.",
  ].join("\n");
}

function buildChannelSettingsKeyboard(cfg, idx) {
  const ch = cfg.channels[idx];
  const rows = [];
  if (ch.keywords?.length > 0) {
    for (let i = 0; i < ch.keywords.length; i += 2) {
      const row = [];
      for (let j = i; j < Math.min(i + 2, ch.keywords.length); j++) row.push({ text: `❌ ${ch.keywords[j]}`, callback_data: `del_kw:${idx}:${j}` });
      rows.push(row);
    }
  }
  rows.push([{ text: "➕ افزودن کلمه", callback_data: `add_kw:${idx}` }]);
  rows.push([{ text: ch.active ? "🔴 غیرفعال" : "🟢 فعال", callback_data: `toggle_ch:${idx}` }]);
  rows.push([{ text: "🧹 پاک کردن کلمات", callback_data: `clear_kw:${idx}` }, { text: "❌ حذف کانال", callback_data: `del_ch:${idx}` }]);
  rows.push([{ text: "↩️ بازگشت به کانال‌ها", callback_data: "channels_menu" }]);
  return { inline_keyboard: rows };
}

/* ============================================================
   Push Notification
   ============================================================ */

function buildPushText(posts) {
  if (posts.length === 1) {
    const p = posts[0];
    let body = (p.text || "(بدون متن)").trim();
    if (body.length > 800) body = body.slice(0, 800) + "…";
    return [
      `🔔 <b>پست جدید مطابق فیلتر</b>`,
      `📢 @${escapeHtml(p.channelName)}`,
      "",
      escapeHtml(body),
      "",
      `🔗 <a href="${p.url}">مشاهده در کانال</a>` + (p.views ? `  |  👁 ${escapeHtml(p.views)}` : ""),
      p.timestamp ? `🕐 ${escapeHtml(p.timestamp)}` : "",
    ].filter(Boolean).join("\n");
  }

  const displayCount = Math.min(posts.length, PUSH_MAX_PER_MSG);
  const lines = [`🔔 <b>${posts.length} پست جدید مطابق فیلتر</b>`];
  if (posts.length > PUSH_MAX_PER_MSG) lines.push(`<i>(نمایش ${displayCount} پست اول — بقیه در داشبورد)</i>`);
  lines.push("");
  for (let i = 0; i < displayCount; i++) {
    const p = posts[i];
    let body = (p.text || "(بدون متن)").trim();
    if (body.length > 200) body = body.slice(0, 200) + "…";
    lines.push(`<b>${i + 1}. @${escapeHtml(p.channelName)}</b>`);
    lines.push(escapeHtml(body));
    lines.push(`<a href="${p.url}">🔗 مشاهده</a>`);
    if (i < displayCount - 1) lines.push("");
  }
  let text = lines.join("\n");
  if (text.length > 4000) text = text.slice(0, 3997) + "...";
  return text;
}

async function sendPushNotification(env, cfg, posts) {
  if (!posts || posts.length === 0) return;
  try {
    const text = buildPushText(posts);
    console.log(`[PUSH] Sending for ${posts.length} post(s)`);
    const res = await sendTelegram(env, cfg.chatId, text);
    if (!res?.ok) console.error("[PUSH] failed:", JSON.stringify(res));
    else console.log(`[PUSH] Sent, messageId=${res.result.message_id}`);
  } catch (err) { console.error("[PUSH]", err.message); }
}

/* ============================================================
   Update handlers
   ============================================================ */

async function handleUpdate(env, update) {
  if (update.message) return handleMessage(env, update.message);
  if (update.callback_query) return handleCallback(env, update.callback_query);
}

async function handleMessage(env, msg) {
  const chatId = msg.chat.id;
  const text = (msg.text || "").trim();
  const messageId = msg.message_id;
  console.log("[MSG] chatId=", chatId, "text=", text.slice(0, 50));

  const cfg = await getConfig(env);
  if (cfg?.chatId && chatId !== cfg.chatId && text !== "/start") return;

  // Track user's message for cleanup in next cron
  if (cfg) {
    cfg.pendingDeletes = cfg.pendingDeletes || [];
    cfg.pendingDeletes.push(messageId);
    await saveConfig(env, cfg);
  }

  const pending = await env.SEEN_POSTS.get(`pending:${chatId}`);

  if (pending === "awaiting_channel") {
    const name = text.replace(/^@/, "").trim();
    if (!/^[A-Za-z0-9_]{3,64}$/.test(name)) { await sendTempMessage(env, cfg, "❌ نام کانال نامعتبر."); return; }
    if (cfg.channels.find(c => c.name.toLowerCase() === name.toLowerCase())) {
      await env.SEEN_POSTS.delete(`pending:${chatId}`);
      await sendTempMessage(env, cfg, "⚠️ این کانال قبلاً اضافه شده.");
      return;
    }
    cfg.channels.push({ name, keywords: [], active: true });
    await saveConfig(env, cfg);
    await env.SEEN_POSTS.delete(`pending:${chatId}`);
    await initChannelSeen(env, name);
    await sendTempMessage(env, cfg, `✅ کانال <code>@${escapeHtml(name)}</code> اضافه شد.\n<i>بدون کلمه کلیدی: فقط داشبورد، بدون پوش.</i>`);
    await editChannelsMenu(env, cfg);
    return;
  }

  if (pending && pending.startsWith("awaiting_keyword:")) {
    const idx = parseInt(pending.split(":")[1], 10);
    if (!cfg.channels[idx]) { await env.SEEN_POSTS.delete(`pending:${chatId}`); return; }
    const kw = text.trim();
    if (!kw || kw.length > 50) { await env.SEEN_POSTS.delete(`pending:${chatId}`); await sendTempMessage(env, cfg, "❌ کلمه نامعتبر."); return; }
    if (!cfg.channels[idx].keywords.includes(kw)) cfg.channels[idx].keywords.push(kw);
    await saveConfig(env, cfg);
    await env.SEEN_POSTS.delete(`pending:${chatId}`);
    await sendTempMessage(env, cfg, `✅ کلمه <code>${escapeHtml(kw)}</code> به @${escapeHtml(cfg.channels[idx].name)} اضافه شد.\n🔔 از این پس پست‌های مطابق پوش می‌شوند.`);
    await editChannelSettings(env, cfg, idx);
    return;
  }

  if (text === "/start") return initFixedMessage(env, chatId);
  if (text === "/help") { await sendTempMessage(env, cfg, HELP_TEXT); return; }
  if (text === "/cancel") {
    await env.SEEN_POSTS.delete(`pending:${chatId}`);
    await sendTempMessage(env, cfg, "✅ لغو شد.");
    return;
  }
}

async function handleCallback(env, cq) {
  const chatId = cq.message?.chat?.id;
  const data = cq.data;
  const cfg = await getConfig(env);
  if (!cfg || chatId !== cfg.chatId) return answerCallback(env, cq.id, "⛔️ دسترسی ندارید", true);

  if (data === "refresh") {
    await answerCallback(env, cq.id, "🔄 در حال بررسی...");
    await checkAndUpdate(env, { force: true });
    return answerCallback(env, cq.id, "✅ بروزرسانی شد");
  }
  if (data === "toggle") {
    cfg.active = !cfg.active; await saveConfig(env, cfg);
    const { posts, stats } = await getAllPostsFiltered(env, cfg);
    const ok = await tryEditMessage(env, cfg, buildDashboardText(cfg, posts, stats), buildKeyboard(cfg));
    if (!ok) await createFixedMessage(env, cfg);
    return answerCallback(env, cq.id, cfg.active ? "🟢 فعال" : "🔴 متوقف");
  }
  if (data === "toggle_push") {
    cfg.pushEnabled = cfg.pushEnabled === false;
    await saveConfig(env, cfg);
    const { posts, stats } = await getAllPostsFiltered(env, cfg);
    const ok = await tryEditMessage(env, cfg, buildDashboardText(cfg, posts, stats), buildKeyboard(cfg));
    if (!ok) await createFixedMessage(env, cfg);
    return answerCallback(env, cq.id, cfg.pushEnabled ? "🔔 پوش روشن شد" : "🔕 پوش خاموش شد");
  }
  if (data === "toggle_view") {
    cfg.viewMode = cfg.viewMode === "single" ? "list" : "single"; await saveConfig(env, cfg);
    const { posts, stats } = await getAllPostsFiltered(env, cfg);
    const ok = await tryEditMessage(env, cfg, buildDashboardText(cfg, posts, stats), buildKeyboard(cfg));
    if (!ok) await createFixedMessage(env, cfg);
    return answerCallback(env, cq.id, cfg.viewMode === "single" ? "🎯 تکی" : "📋 لیست");
  }
  if (data === "reset") {
    await clearSeen(env);
    await answerCallback(env, cq.id, "🗑️ کش پاک شد");
    await checkAndUpdate(env, { force: true });
    return;
  }
  if (data === "help") {
    await answerCallback(env, cq.id, "❓");
    await sendTempMessage(env, cfg, HELP_TEXT);
    return;
  }
  if (data === "back") {
    const { posts, stats } = await getAllPostsFiltered(env, cfg);
    await tryEditMessage(env, cfg, buildDashboardText(cfg, posts, stats), buildKeyboard(cfg));
    return answerCallback(env, cq.id, "↩️");
  }
  if (data === "noop") return answerCallback(env, cq.id, "—");

  if (data === "channels_menu") { await editChannelsMenu(env, cfg); return answerCallback(env, cq.id, "📢"); }
  if (data === "add_channel") {
    await env.SEEN_POSTS.put(`pending:${chatId}`, "awaiting_channel", { expirationTtl: 300 });
    await answerCallback(env, cq.id, "نام کانال را بفرستید");
    await sendTempMessage(env, cfg, "📢 نام کانال جدید (بدون @).\nمثال: <code>Akhbare_madrs</code>\n⏱ ۵ دقیقه. /cancel برای لغو.");
    return;
  }
  if (data.startsWith("ch_settings:")) {
    const idx = parseInt(data.split(":")[1], 10);
    if (!cfg.channels[idx]) return answerCallback(env, cq.id, "یافت نشد", true);
    await editChannelSettings(env, cfg, idx);
    return answerCallback(env, cq.id, "⚙️");
  }
  if (data.startsWith("toggle_ch:")) {
    const idx = parseInt(data.split(":")[1], 10);
    if (!cfg.channels[idx]) return answerCallback(env, cq.id, "یافت نشد", true);
    cfg.channels[idx].active = !cfg.channels[idx].active;
    await saveConfig(env, cfg);
    await editChannelSettings(env, cfg, idx);
    return answerCallback(env, cq.id, cfg.channels[idx].active ? "🟢 فعال" : "🔴 غیرفعال");
  }
  if (data.startsWith("del_ch:")) {
    const idx = parseInt(data.split(":")[1], 10);
    if (!cfg.channels[idx]) return answerCallback(env, cq.id, "یافت نشد", true);
    const removed = cfg.channels.splice(idx, 1)[0];
    await saveConfig(env, cfg);
    await clearSeenChannel(env, removed.name);
    await editChannelsMenu(env, cfg);
    return answerCallback(env, cq.id, `❌ @${removed.name} حذف شد`);
  }
  if (data.startsWith("add_kw:")) {
    const idx = parseInt(data.split(":")[1], 10);
    if (!cfg.channels[idx]) return answerCallback(env, cq.id, "یافت نشد", true);
    await env.SEEN_POSTS.put(`pending:${chatId}`, `awaiting_keyword:${idx}`, { expirationTtl: 300 });
    await answerCallback(env, cq.id, "کلمه را بفرستید");
    await sendTempMessage(env, cfg, `🔤 کلمه برای @${escapeHtml(cfg.channels[idx].name)}:\nمثال: <code>تهران</code>\n⏱ ۵ دقیقه. /cancel برای لغو.`);
    return;
  }
  if (data.startsWith("del_kw:")) {
    const parts = data.split(":");
    const idx = parseInt(parts[1], 10), kwIdx = parseInt(parts[2], 10);
    if (!cfg.channels[idx] || !cfg.channels[idx].keywords[kwIdx]) return answerCallback(env, cq.id, "یافت نشد", true);
    const removed = cfg.channels[idx].keywords.splice(kwIdx, 1)[0];
    await saveConfig(env, cfg);
    await editChannelSettings(env, cfg, idx);
    return answerCallback(env, cq.id, `❌ «${removed}» حذف شد`);
  }
  if (data.startsWith("clear_kw:")) {
    const idx = parseInt(data.split(":")[1], 10);
    if (!cfg.channels[idx]) return answerCallback(env, cq.id, "یافت نشد", true);
    cfg.channels[idx].keywords = [];
    await saveConfig(env, cfg);
    await editChannelSettings(env, cfg, idx);
    return answerCallback(env, cq.id, "🧹 پاک شد — بدون پوش");
  }

  await answerCallback(env, cq.id, "❓ نامشخص", true);
}

async function editChannelsMenu(env, cfg) {
  await tryEditMessage(env, cfg, ["📢 <b>مدیریت کانال‌ها</b>", "", "روی هر کانال بزنید تا فیلتر و پوش را تنظیم کنید.", "", "🔔 با کلمه = پوش  |  🔕 بدون کلمه = فقط داشبورد"].join("\n"), buildChannelsKeyboard(cfg));
}
async function editChannelSettings(env, cfg, idx) {
  await tryEditMessage(env, cfg, buildChannelSettingsText(cfg, idx), buildChannelSettingsKeyboard(cfg, idx));
}

/* ============================================================
   Cron
   ============================================================ */

async function checkAndUpdate(env, opts = {}) {
  const cfg = await getConfig(env);
  if (!cfg) return;

  const today = getTehranDate();
  if (cfg.lastResetDate !== today) { await performMidnightReset(env, cfg, today); return; }

  cfg.lastCheckTime = Date.now();
  await saveConfig(env, cfg);

  if (cfg.pendingDeletes?.length > 0) {
    for (const mid of cfg.pendingDeletes) await deleteMessage(env, cfg.chatId, mid);
    cfg.pendingDeletes = [];
    await saveConfig(env, cfg);
  }

  if (!cfg.active && !opts.force) return;

  const newMatchingPosts = [];
  const pushablePosts = [];

  for (const ch of cfg.channels) {
    if (!ch.active) continue;
    try {
      const posts = await getLatestPosts(env, { channel: ch.name, limit: 30 });
      const sortedAsc = [...posts].sort((a, b) => a.id - b.id);
      const initKey = `init:${ch.name}`;
      if (!(await env.SEEN_POSTS.get(initKey)) && !opts.force) {
        for (const p of sortedAsc) await env.SEEN_POSTS.put(`seen:${ch.name}:${p.id}`, "1", { expirationTtl: 604800 });
        await env.SEEN_POSTS.put(initKey, "1");
        continue;
      }
      for (const p of sortedAsc) {
        const key = `seen:${ch.name}:${p.id}`;
        if (await env.SEEN_POSTS.get(key)) continue;
        await env.SEEN_POSTS.put(key, "1", { expirationTtl: 604800 });
        if (matchesChannelKeywords(p, ch)) {
          const item = { ...p, channelName: ch.name };
          newMatchingPosts.push(item);
          if (shouldPushPost(p, ch)) pushablePosts.push(item);
        }
      }
    } catch (err) { console.error(`[CRON] channel ${ch.name}:`, err.message); }
  }

  if (newMatchingPosts.length > 0 || opts.force) {
    const { posts, stats } = await getAllPostsFiltered(env, cfg);
    const ok = await tryEditMessage(env, cfg, buildDashboardText(cfg, posts, stats), buildKeyboard(cfg));
    if (!ok) await createFixedMessage(env, cfg);
  }

  // Push only for matched posts with keywords, and not on manual refresh
  if (pushablePosts.length > 0 && cfg.pushEnabled !== false && !opts.force) {
    await sendPushNotification(env, cfg, pushablePosts);
  }
}

async function performMidnightReset(env, cfg, today) {
  console.log("[RESET] Midnight reset");
  await deleteAllBotMessages(env, cfg.chatId);
  await clearSeen(env);
  for (const ch of cfg.channels) ch.keywords = [];
  cfg.messageId = null;
  cfg.pendingDeletes = [];
  cfg.lastResetDate = today;
  cfg.lastCheckTime = Date.now();
  await saveConfig(env, cfg);
  await createFixedMessage(env, cfg);
  await sendTempMessage(env, cfg, "🌙 <b>ریست نیمه‌شب انجام شد.</b>\nهمه پوش‌ها، فیلترها و پیام‌های قبلی پاک شدند.\n<i>این پیام در تریگر بعدی حذف می‌شود.</i>");
}

async function getAllPostsFiltered(env, cfg) {
  const all = [];
  for (const ch of cfg.channels) {
    if (!ch.active) continue;
    try {
      const posts = await getLatestPosts(env, { channel: ch.name, limit: 10 });
      for (const p of posts) if (matchesChannelKeywords(p, ch)) all.push({ ...p, channelName: ch.name });
    } catch {}
  }
  all.sort((a, b) => (Date.parse(b.timestamp || 0) || 0) - (Date.parse(a.timestamp || 0) || 0));
  const today = new Date().toISOString().slice(0, 10);
  const todayCount = all.filter(p => p.timestamp && p.timestamp.startsWith(today)).length;
  return { posts: all, stats: { todayCount } };
}

async function initChannelSeen(env, channelName) {
  try {
    const posts = await getLatestPosts(env, { channel: channelName, limit: 30 });
    for (const p of posts) await env.SEEN_POSTS.put(`seen:${channelName}:${p.id}`, "1", { expirationTtl: 604800 });
    await env.SEEN_POSTS.put(`init:${channelName}`, "1");
  } catch (err) { console.error("[INIT_CH]", err.message); }
}

async function clearSeen(env) {
  const l1 = await env.SEEN_POSTS.list({ prefix: "seen:", limit: 1000 });
  await Promise.all(l1.keys.map(k => env.SEEN_POSTS.delete(k.name)));
  const l2 = await env.SEEN_POSTS.list({ prefix: "init:", limit: 100 });
  await Promise.all(l2.keys.map(k => env.SEEN_POSTS.delete(k.name)));
}
async function clearSeenChannel(env, channelName) {
  const l1 = await env.SEEN_POSTS.list({ prefix: `seen:${channelName}:`, limit: 1000 });
  await Promise.all(l1.keys.map(k => env.SEEN_POSTS.delete(k.name)));
  await env.SEEN_POSTS.delete(`init:${channelName}`);
}

/* ============================================================
   Telegram helpers
   ============================================================ */

async function sendTelegramRaw(env, chatId, text, keyboard, retryOnParseError = true) {
  const body = { chat_id: chatId, text, parse_mode: "HTML", disable_web_page_preview: true };
  if (keyboard) body.reply_markup = keyboard;
  let res = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/sendMessage`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });
  let data = await res.json();
  if (retryOnParseError && !data.ok && data.description?.includes("can't parse entities")) {
    body.text = text.replace(/<[^>]+>/g, "");
    delete body.parse_mode;
    res = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/sendMessage`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
    });
    data = await res.json();
  }
  return data;
}

async function sendTelegram(env, chatId, text) {
  const res = await sendTelegramRaw(env, chatId, text, null);
  if (res?.ok && res.result?.message_id) await trackMessage(env, chatId, res.result.message_id);
  return res;
}

async function sendTempMessage(env, cfg, text) {
  if (!cfg) return;
  const res = await sendTelegramRaw(env, cfg.chatId, text, null);
  if (res?.ok && res.result?.message_id) {
    cfg.pendingDeletes = cfg.pendingDeletes || [];
    cfg.pendingDeletes.push(res.result.message_id);
    await saveConfig(env, cfg);
  }
  return res;
}

async function trackMessage(env, chatId, messageId) {
  try {
    const key = `botMsgs:${chatId}`;
    const raw = await env.SEEN_POSTS.get(key);
    let arr = raw ? JSON.parse(raw) : [];
    arr.push(messageId);
    if (arr.length > 100) arr = arr.slice(-100);
    await env.SEEN_POSTS.put(key, JSON.stringify(arr), { expirationTtl: 604800 });
  } catch (err) { console.error("[TRACK]", err.message); }
}

async function deleteAllBotMessages(env, chatId) {
  const key = `botMsgs:${chatId}`;
  const raw = await env.SEEN_POSTS.get(key);
  if (raw) {
    try {
      const arr = JSON.parse(raw);
      console.log(`[RESET] Deleting ${arr.length} bot messages`);
      for (const mid of arr) await deleteMessage(env, chatId, mid);
    } catch (err) { console.error("[RESET_DEL]", err.message); }
  }
  await env.SEEN_POSTS.delete(key);
}

async function deleteMessage(env, chatId, messageId) {
  try {
    await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/deleteMessage`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, message_id: messageId }),
    });
  } catch (err) { console.error("[DEL]", err.message); }
}

async function answerCallback(env, callbackId, text, alert = false) {
  return fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/answerCallbackQuery`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ callback_query_id: callbackId, text, show_alert: alert }),
  }).then(r => r.json());
}

/* ============================================================
   Help text
   ============================================================ */

const HELP_TEXT = [
  "❓ <b>راهنمای ربات v1.5</b>",
  "",
  "داشبورد ثابت با چند کانال، فیلتر مستقل و پوش هوشمند.",
  "",
  "🔄 <b>بروزرسانی</b> — بررسی فوری",
  "🟢/🔴 <b>توقف/شروع</b> — کل رصد",
  "🔔/🔕 <b>پوش</b> — روشن/خاموش کردن پوش کلی",
  "🎯/📋 <b>نمایش</b> — تک‌پست یا لیست",
  "📢 <b>کانال‌ها</b> — افزودن کانال + فیلتر هر کدام",
  "🟣 <b>ریست</b> — پاک کردن کش",
  "",
  "🔔 <b>منطق پوش:</b>",
  "کانال با فیلتر → پست مطابق پوش می‌شود",
  "کانال بدون فیلتر → فقط داشبورد، بدون پوش",
  "",
  "🌙 <b>ریست نیمه‌شب (۰۰:۰۰ تهران):</b>",
  "همه پوش‌ها، فیلترها و پیام‌های ربات خودکار پاک می‌شوند.",
  "",
  "<b>دستورات:</b> /start /help /cancel",
].join("\n");

/* ============================================================
   MCP tools + utils
   ============================================================ */

function escapeHtml(s) { return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); }

async function callTool(env, name, args) {
  if (name === "get_channel_info") return getChannelInfo(env, args);
  if (name === "get_latest_posts") return getLatestPosts(env, args);
  if (name === "search_posts") return searchPosts(env, args);
  throw new Error(`Unknown tool: ${name}`);
}

async function getChannelInfo(env, args) {
  const channel = normalizeChannel(requiredString(args.channel, "channel"));
  const html = await fetchTelegramHtml(env, channel);
  const title = firstText(html, /<div class="tgme_channel_info_header_title"[^>]*>([\s\S]*?)<\/div>/) || firstText(html, /<meta property="og:title" content="([^"]*)"/);
  const subscriberCount = firstText(html, /<div class="tgme_channel_info_counter"[^>]*>([\s\S]*?)<\/div>/);
  const hasChannelMarkers = html.includes("tgme_channel_info") || html.includes("tgme_widget_message");
  if (!hasChannelMarkers || title === "Telegram – a new era of messaging") throw new Error(`Public channel not found: ${channel}`);
  return { title, description: firstText(html, /<div class="tgme_channel_info_description"[^>]*>([\s\S]*?)<\/div>/) || firstText(html, /<meta property="og:description" content="([^"]*)"/), avatarUrl: absoluteUrl(firstAttr(html, /<img class="tgme_page_photo_image"[^>]*src="([^"]+)"/), baseUrl(env)), subscriberCount, url: `${baseUrl(env)}/s/${channel}`, channel };
}

async function getLatestPosts(env, args) {
  const channel = normalizeChannel(requiredString(args.channel, "channel"));
  const limit = clampLimit(args.limit);
  const beforePostId = args.before_post_id == null ? null : Number(args.before_post_id);
  const beforeTime = args.before_time ? Date.parse(args.before_time) : null;
  let url = `${baseUrl(env)}/s/${channel}`;
  if (beforePostId && Number.isFinite(beforePostId)) url += `?before=${beforePostId}`;
  return parsePosts(await fetchUrl(url), channel).sort((a, b) => b.id - a.id).filter(p => beforeTime ? Date.parse(p.timestamp || "") < beforeTime : true).slice(0, limit);
}

async function searchPosts(env, args) {
  const channel = normalizeChannel(requiredString(args.channel, "channel"));
  const query = requiredString(args.query, "query");
  return parsePosts(await fetchUrl(`${baseUrl(env)}/s/${channel}?q=${encodeURIComponent(query)}`), channel).slice(0, clampLimit(args.limit));
}

async function fetchTelegramHtml(env, channel) { return fetchUrl(`${baseUrl(env)}/s/${channel}`); }

async function fetchUrl(url) {
  const res = await fetch(url, { headers: { "user-agent": "Mozilla/5.0 (compatible; telegram-public-mcp-cf/1.5)", "accept": "text/html,application/xhtml+xml" } });
  if (!res.ok) throw new Error(`Telegram public page HTTP ${res.status}`);
  return res.text();
}

function parsePosts(html, channel) {
  const blocks = [...html.matchAll(/<div class="tgme_widget_message_wrap[\s\S]*?(?=<div class="tgme_widget_message_wrap|<\/main>|$)/g)].map(m => m[0]);
  return blocks.map(b => parsePost(b, channel)).filter(Boolean);
}

function parsePost(block, channel) {
  const href = firstAttr(block, /<a class="tgme_widget_message_date"[^>]*href="([^"]+)"/);
  const idMatch = href?.match(/\/(\d+)(?:\?|$)/);
  const id = idMatch ? Number(idMatch[1]) : null;
  if (!id) return null;
  const datetime = firstAttr(block, /<time[^>]*datetime="([^"]+)"/);
  const textHtml = firstMatch(block, /<div class="tgme_widget_message_text[^"]*"[^>]*>([\s\S]*?)<\/div>/) || "";
  const imageUrls = [...block.matchAll(/background-image:url\('([^']+)'\)/g)].map(m => htmlDecode(m[1]));
  const views = firstText(block, /<span class="tgme_widget_message_views">([\s\S]*?)<\/span>/);
  const author = firstText(block, /<div class="tgme_widget_message_author[\s\S]*?<span[^>]*>([\s\S]*?)<\/span>/);
  return { id, channel, url: href ? absoluteUrl(href, "https://t.me") : `https://t.me/${channel}/${id}`, text: cleanText(textHtml), imageUrls, views, timestamp: datetime || null, author };
}

function baseUrl(env) { return (env.TELEGRAM_BASE_URL || "https://t.me").replace(/\/$/, ""); }
function requiredString(v, name) { if (typeof v !== "string" || !v.trim()) throw new Error(`${name} is required`); return v.trim(); }
function clampLimit(v) { const n = v == null ? 10 : Number(v); return Math.max(1, Math.min(MAX_LIMIT, Number.isFinite(n) ? Math.floor(n) : 10)); }
function normalizeChannel(input) {
  let s = input.trim();
  if (/^https?:\/\/(?:www\.)?t\.me\/s\//i.test(s)) s = s.replace(/^https?:\/\/(?:www\.)?t\.me\/s\//i, "").split(/[/?#]/)[0];
  else if (/^https?:\/\/(?:www\.)?t\.me\//i.test(s)) s = s.replace(/^https?:\/\/(?:www\.)?t\.me\//i, "").split(/[/?#]/)[0];
  else { s = s.replace(/^@/, ""); if (/[\/?#]/.test(s)) throw new Error("Invalid channel"); }
  if (!/^[A-Za-z0-9_]{3,64}$/.test(s)) throw new Error("Invalid channel");
  return s;
}
function firstMatch(s, re) { return s.match(re)?.[1]; }
function firstText(s, re) { const m = firstMatch(s, re); return m == null ? null : cleanText(m); }
function firstAttr(s, re) { const m = firstMatch(s, re); return m == null ? null : htmlDecode(m); }
function cleanText(html) { return htmlDecode(String(html).replace(/<br\s*\/?>/gi, "\n").replace(/<\/(p|div)>/gi, "\n").replace(/<[^>]+>/g, "").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim()); }
function htmlDecode(s) { return String(s).replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&#x27;/g, "'").replace(/&#x2F;/g, "/").replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n))).replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16))); }
function absoluteUrl(u, base) { if (!u) return null; if (/^https?:\/\//i.test(u)) return u; return `${base}${u.startsWith("/") ? "" : "/"}${u}`; }
function json(obj, status = 200) { return new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json; charset=utf-8" } }); }
function rpcError(id, code, message) { return json({ jsonrpc: "2.0", id, error: { code, message } }); }
