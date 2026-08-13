/*
===========================================================
 mynote_bot — V14 HYBRID FINAL BALE WEBHOOK
===========================================================

Architecture:
- Bale Bot API
- Bale Webhook ingestion
- Canonical webhook: /webhook
- Legacy webhook: /telegram/webhook
- Independent KV Queue
- Album aggregation
- Batch-safe ingestion
- Random 3–10 minute sending interval
- Persistent scheduler
- Smart retry + exponential backoff
- Dead Letter Queue
- Lease lock
- Duplicate update protection
- 60-minute Bale reporting
- Health / Status / Admin endpoints
- Webhook setup + webhook info
- Strong debug logging
- TTL protection: NEVER < 60 seconds

Version:
V14-HYBRID-FINAL-2026-08-14-BALE-WEBHOOK

IMPORTANT:
Cron should be configured in Cloudflare as:

* * * * *

Cron runs every minute.
Actual post sending is controlled internally by nextSendAt.

BALE:
- BALE_BOT_TOKEN
- BALE_TOKEN
- BALE_API_BASE (optional)
- BALE_WEBHOOK_SECRET (optional)
- DEST_CHANNEL_ID supported
===========================================================
*/

const VERSION = "V14-HYBRID-FINAL-2026-08-14-BALE-WEBHOOK";

/* =========================================================
   DEFAULT CONFIGURATION
========================================================= */

const DEFAULTS = {
  MIN_DELAY_SEC: 180,
  MAX_DELAY_SEC: 600,

  ALBUM_QUIET_SEC: 15,

  REPORT_INTERVAL_SEC: 3600,

  LOCK_TTL_SEC: 120,

  PROCESSING_LEASE_SEC: 300,

  SEEN_UPDATE_TTL_SEC: 604800,

  ALBUM_TTL_SEC: 900,

  DLQ_TTL_SEC: 2592000,

  MAX_RETRIES: 5,

  MAX_QUEUE_SCAN: 1000,

  MAX_SENDS_PER_RUN: 1
};


/* =========================================================
   ENVIRONMENT HELPERS
========================================================= */

function getNumber(env, name, fallback) {
  const value = Number(env?.[name]);

  return Number.isFinite(value)
    ? value
    : fallback;
}


function config(env) {
  return {
    MIN_DELAY_SEC: Math.max(
      180,
      getNumber(
        env,
        "MIN_DELAY_SEC",
        DEFAULTS.MIN_DELAY_SEC
      )
    ),

    MAX_DELAY_SEC: Math.max(
      180,
      getNumber(
        env,
        "MAX_DELAY_SEC",
        DEFAULTS.MAX_DELAY_SEC
      )
    ),

    ALBUM_QUIET_SEC: Math.max(
      15,
      getNumber(
        env,
        "ALBUM_QUIET_SEC",
        DEFAULTS.ALBUM_QUIET_SEC
      )
    ),

    REPORT_INTERVAL_SEC: Math.max(
      3600,
      getNumber(
        env,
        "REPORT_INTERVAL_SEC",
        DEFAULTS.REPORT_INTERVAL_SEC
      )
    ),

    LOCK_TTL_SEC: Math.max(
      60,
      getNumber(
        env,
        "LOCK_TTL_SEC",
        DEFAULTS.LOCK_TTL_SEC
      )
    ),

    PROCESSING_LEASE_SEC: Math.max(
      60,
      getNumber(
        env,
        "PROCESSING_LEASE_SEC",
        DEFAULTS.PROCESSING_LEASE_SEC
      )
    ),

    SEEN_UPDATE_TTL_SEC: Math.max(
      60,
      getNumber(
        env,
        "SEEN_UPDATE_TTL_SEC",
        DEFAULTS.SEEN_UPDATE_TTL_SEC
      )
    ),

    ALBUM_TTL_SEC: Math.max(
      60,
      getNumber(
        env,
        "ALBUM_TTL_SEC",
        DEFAULTS.ALBUM_TTL_SEC
      )
    ),

    DLQ_TTL_SEC: Math.max(
      60,
      getNumber(
        env,
        "DLQ_TTL_SEC",
        DEFAULTS.DLQ_TTL_SEC
      )
    ),

    MAX_RETRIES: Math.max(
      1,
      getNumber(
        env,
        "MAX_RETRIES",
        DEFAULTS.MAX_RETRIES
      )
    ),

    MAX_QUEUE_SCAN: Math.max(
      50,
      getNumber(
        env,
        "MAX_QUEUE_SCAN",
        DEFAULTS.MAX_QUEUE_SCAN
      )
    ),

    MAX_SENDS_PER_RUN:
      DEFAULTS.MAX_SENDS_PER_RUN
  };
}


/* =========================================================
   KV BINDING
========================================================= */

function getKV(env) {
  return (
    env.KV ||
    env.QUEUE_KV ||
    env.MY_KV ||
    env.MYNOTE_KV ||
    env.MYNOTE_QUEUE
  );
}


function requireKV(env) {
  const kv = getKV(env);

  if (!kv) {
    throw new Error(
      "KV binding not found. Expected KV / QUEUE_KV / MY_KV / MYNOTE_KV / MYNOTE_QUEUE."
    );
  }

  return kv;
}


/* =========================================================
   SAFE KV FUNCTIONS
========================================================= */

async function kvGetJSON(kv, key) {
  try {
    return await kv.get(
      key,
      {
        type: "json",
        cacheTtl: 30
      }
    );
  } catch (error) {
    console.error(
      JSON.stringify({
        event: "KV_GET_ERROR",
        key,
        error:
          error?.message ||
          String(error)
      })
    );

    throw error;
  }
}


async function kvPutJSON(
  kv,
  key,
  value,
  expirationTtl
) {
  try {
    await kv.put(
      key,
      JSON.stringify(value),
      {
        expirationTtl:
          Math.max(
            60,
            Number(expirationTtl) || 60
          )
      }
    );
  } catch (error) {
    console.error(
      JSON.stringify({
        event: "KV_PUT_ERROR",
        key,
        error:
          error?.message ||
          String(error)
      })
    );

    throw error;
  }
}


async function kvDelete(
  kv,
  key
) {
  try {
    await kv.delete(key);
  } catch (error) {
    console.error(
      JSON.stringify({
        event: "KV_DELETE_ERROR",
        key,
        error:
          error?.message ||
          String(error)
      })
    );

    throw error;
  }
}


/* =========================================================
   TIME HELPERS
========================================================= */

function nowMs() {
  return Date.now();
}


function iso(ms = Date.now()) {
  return new Date(ms).toISOString();
}


function seconds(ms) {
  return Math.floor(
    ms / 1000
  );
}


/* =========================================================
   BALE BOT API
========================================================= */

function telegramToken(env) {
  return (
    env.BALE_BOT_TOKEN ||
    env.BALE_TOKEN ||
    env.TELEGRAM_BOT_TOKEN ||
    env.BOT_TOKEN ||
    env.TELEGRAM_TOKEN
  );
}


async function telegramAPI(
  env,
  method,
  payload
) {
  const token =
    telegramToken(env);

  if (!token) {
    throw new Error(
      "BALE_BOT_TOKEN is not configured."
    );
  }

  const url =
    (
      env.BALE_API_BASE ||
      "https://tapi.bale.ai/bot"
    ) +
    token +
    "/" +
    method;

  let response;

  try {
    response =
      await fetch(
        url,
        {
          method: "POST",

          headers: {
            "Content-Type":
              "application/json"
          },

          body:
            JSON.stringify(
              payload
            )
        }
      );
  } catch (error) {

    const e =
      new Error(
        "Bale network error: " +
        (
          error?.message ||
          String(error)
        )
      );

    e.retryable = true;

    throw e;
  }


  let data;

  try {
    data =
      await response.json();
  } catch {
    data = null;
  }


  if (
    !response.ok ||
    !data ||
    data.ok !== true
  ) {

    const description =
      data?.description ||
      `HTTP ${response.status}`;

    const error =
      new Error(
        `Bale API ${method} failed: ${description}`
      );

    error.status =
      response.status;

    error.retryAfter =
      data?.parameters
        ?.retry_after ||
      null;

    error.retryable =
      response.status === 429 ||
      response.status >= 500 ||
      !data;

    throw error;
  }


  return data.result;
}


/* =========================================================
   BALE COPY / FORWARD
========================================================= */

async function copyQueueItem(
  env,
  item
) {

  if (
    !item ||
    !Array.isArray(
      item.messageIds
    ) ||
    item.messageIds.length === 0
  ) {
    throw new Error(
      "Queue item has no message IDs."
    );
  }


  const sourceChatId =
    item.sourceChatId;


  const targetChatId =
    item.targetChatId ||
    targetChatIdFromEnv(env);


  if (!sourceChatId) {
    throw new Error(
      "Queue item sourceChatId is missing."
    );
  }


  if (!targetChatId) {
    throw new Error(
      "No destination configured. Set TARGET_CHAT_ID, DESTINATION_CHAT_ID, or DEST_CHANNEL_ID."
    );
  }


  const results = [];


  for (
    const mid of
    item.messageIds
  ) {

    let r;


    try {

      r =
        await telegramAPI(
          env,
          "copyMessage",
          {
            chat_id:
              targetChatId,

            from_chat_id:
              sourceChatId,

            message_id:
              mid
          }
        );

    } catch (error) {

      console.warn(
        JSON.stringify({
          event:
            "COPY_MESSAGE_FALLBACK",

          messageId:
            mid,

          error:
            error?.message ||
            String(error)
        })
      );


      r =
        await telegramAPI(
          env,
          "forwardMessage",
          {
            chat_id:
              targetChatId,

            from_chat_id:
              sourceChatId,

            message_id:
              mid
          }
        );
    }


    results.push(r);
  }


  return results;
}


/* =========================================================
   SOURCE / TARGET CONFIG
========================================================= */

function sourceChatId(env) {

  return String(
    env.SOURCE_CHAT_ID ||
    env.SOURCE_CHANNEL_ID ||
    ""
  );
}


function targetChatIdFromEnv(
  env
) {

  return String(
    env.TARGET_CHAT_ID ||
    env.DESTINATION_CHAT_ID ||
    env.DEST_CHANNEL_ID ||
    ""
  );
}


/* =========================================================
   RANDOM DELAY
========================================================= */

function randomDelaySeconds(
  env
) {

  const cfg =
    config(env);

  const min =
    cfg.MIN_DELAY_SEC;

  const max =
    Math.max(
      min,
      cfg.MAX_DELAY_SEC
    );

  return Math.floor(
    min +
    Math.random() *
      (
        max -
        min +
        1
      )
  );
}


/* =========================================================
   KEY HELPERS
========================================================= */

function queueKey(
  id
) {
  return `queue:${id}`;
}


function dlqKey(
  id
) {
  return `dlq:${id}`;
}


function seenUpdateKey(
  updateId
) {
  return `seen:update:${updateId}`;
}


function albumKey(
  chatId,
  mediaGroupId
) {
  return (
    `album:${chatId}:${mediaGroupId}`
  );
}


function lockKey() {
  return "system:lock";
}


function schedulerKey() {
  return "system:scheduler";
}


/* =========================================================
   QUEUE HELPERS
========================================================= */

async function getQueueItem(
  kv,
  id
) {
  return await kvGetJSON(
    kv,
    queueKey(id)
  );
}


async function saveQueueItem(
  env,
  kv,
  item
) {

  const ttl =
    config(env)
      .DLQ_TTL_SEC;

  await kvPutJSON(
    kv,
    queueKey(
      item.id
    ),
    item,
    ttl
  );
}


async function deleteQueueItem(
  kv,
  id
) {
  await kvDelete(
    kv,
    queueKey(id)
  );
}


async function listQueue(
  env,
  kv
) {

  const cfg =
    config(env);

  const list =
    await kv.list({
      prefix: "queue:",
      limit:
        cfg.MAX_QUEUE_SCAN
    });

  const items = [];


  for (
    const key of
    list.keys
  ) {

    const id =
      key.name.replace(
        "queue:",
        ""
      );

    const item =
      await getQueueItem(
        kv,
        id
      );

    if (item) {
      items.push(item);
    }
  }


  items.sort(
    (a, b) =>
      (
        Number(
          a.createdAt
        ) || 0
      ) -
      (
        Number(
          b.createdAt
        ) || 0
      )
  );


  return items;
}


/* =========================================================
   SCHEDULER
========================================================= */

async function getScheduler(
  kv
) {

  return (
    await kvGetJSON(
      kv,
      schedulerKey()
    )
  ) || {
    nextSendAt: 0,
    lastSendAt: 0,
    lastReportAt: 0,
    lastCronAt: 0,
    lastCron: "",
    sent: 0,
    failed: 0
  };
}


async function saveScheduler(
  kv,
  scheduler
) {

  await kvPutJSON(
    kv,
    schedulerKey(),
    scheduler,
    31536000
  );
}


/* =========================================================
   LOCK
========================================================= */

async function acquireLock(
  kv,
  env
) {

  const key =
    lockKey();

  const existing =
    await kv.get(key);

  if (existing) {
    return null;
  }

  const token =
    crypto.randomUUID();

  await kv.put(
    key,
    token,
    {
      expirationTtl:
        config(env)
          .LOCK_TTL_SEC
    }
  );

  const confirmed =
    await kv.get(key);

  if (
    confirmed !== token
  ) {
    return null;
  }

  return token;
}


async function releaseLock(
  kv,
  token
) {

  const key =
    lockKey();

  const existing =
    await kv.get(key);

  if (
    existing === token
  ) {
    await kv.delete(key);
  }
}


/* =========================================================
   DUPLICATE UPDATE PROTECTION
========================================================= */

async function isDuplicateUpdate(
  kv,
  env,
  updateId
) {

  if (
    updateId ===
    undefined ||
    updateId ===
    null
  ) {
    return false;
  }

  const key =
    seenUpdateKey(
      updateId
    );

  const exists =
    await kv.get(key);

  if (exists) {
    return true;
  }

  await kv.put(
    key,
    "1",
    {
      expirationTtl:
        config(env)
          .SEEN_UPDATE_TTL_SEC
    }
  );

  return false;
}


/* =========================================================
   ENQUEUE SINGLE MESSAGE
========================================================= */

async function enqueueMessage(
  env,
  kv,
  message
) {

  const createdAt =
    nowMs();

  const id =
    `msg-${message.chat.id}-${message.message_id}`;

  const item = {

    id,

    type:
      "message",

    sourceChatId:
      String(
        message.chat.id
      ),

    messageIds: [
      Number(
        message.message_id
      )
    ],

    createdAt,

    updatedAt:
      createdAt,

    retryCount:
      0,

    status:
      "pending",

    nextAttemptAt:
      0
  };


  await saveQueueItem(
    env,
    kv,
    item
  );


  return item;
}


/* =========================================================
   ALBUM AGGREGATION
========================================================= */

async function addAlbumMessage(
  env,
  kv,
  message
) {

  const mediaGroupId =
    message.media_group_id;

  const chatId =
    String(
      message.chat.id
    );

  const key =
    albumKey(
      chatId,
      mediaGroupId
    );


  let album =
    await kvGetJSON(
      kv,
      key
    );


  if (!album) {

    album = {

      id:
        `album-${chatId}-${mediaGroupId}`,

      type:
        "album",

      sourceChatId:
        chatId,

      mediaGroupId:
        String(
          mediaGroupId
        ),

      messageIds: [],

      messages: [],

      createdAt:
        nowMs(),

      updatedAt:
        nowMs(),

      status:
        "collecting",

      targetChatId:
        targetChatIdFromEnv(
          env
        )
    };
  }


  const messageId =
    Number(
      message.message_id
    );


  if (
    !album.messageIds.includes(
      messageId
    )
  ) {

    album.messageIds.push(
      messageId
    );

    album.messages.push({

      messageId,

      date:
        Number(
          message.date
        ) || 0
    });
  }


  album.messageIds =
    [
      ...new Set(
        album.messageIds
      )
    ].sort(
      (a, b) =>
        a - b
    );


  album.messages =
    album.messages
      .sort(
        (a, b) =>
          a.messageId -
          b.messageId
      );


  album.updatedAt =
    nowMs();


  await kvPutJSON(
    kv,
    key,
    album,
    config(env)
      .ALBUM_TTL_SEC
  );


  return album;
}


/* =========================================================
   FINALIZE ALBUMS
========================================================= */

async function finalizeAlbums(
  env,
  kv
) {

  const cfg =
    config(env);

  const list =
    await kv.list({
      prefix: "album:",
      limit:
        cfg.MAX_QUEUE_SCAN
    });

  let finalized = 0;


  for (
    const key of
    list.keys
  ) {

    const album =
      await kvGetJSON(
        kv,
        key.name
      );

    if (!album) {
      continue;
    }


    const age =
      nowMs() -
      (
        Number(
          album.updatedAt
        ) || 0
      );


    if (
      age <
      cfg.ALBUM_QUIET_SEC *
        1000
    ) {
      continue;
    }


    if (
      album.status !==
      "collecting"
    ) {
      continue;
    }


    const queueItem = {

      id:
        album.id,

      type:
        "album",

      sourceChatId:
        album.sourceChatId,

      messageIds:
        album.messageIds,

      createdAt:
        album.createdAt,

      updatedAt:
        nowMs(),

      retryCount:
        0,

      status:
        "pending",

      nextAttemptAt:
        0,

      targetChatId:
        album.targetChatId ||
        targetChatIdFromEnv(
          env
        )
    };


    await saveQueueItem(
      env,
      kv,
      queueItem
    );


    album.status =
      "finalized";


    await kvPutJSON(
      kv,
      key.name,
      album,
      cfg.ALBUM_TTL_SEC
    );


    finalized++;
  }


  return finalized;
}


/* =========================================================
   BALE WEBHOOK HANDLER
========================================================= */

async function handleTelegramUpdate(
  request,
  env
) {

  const kv =
    requireKV(env);


  const configuredSecret =
    env.BALE_WEBHOOK_SECRET ||
    env.TELEGRAM_WEBHOOK_SECRET;


  if (
    configuredSecret
  ) {

    const receivedSecret =
      request.headers.get(
        "X-Bale-Bot-Api-Secret-Token"
      ) ||
      request.headers.get(
        "X-Telegram-Bot-Api-Secret-Token"
      );


    if (
      receivedSecret !==
      configuredSecret
    ) {

      console.warn(
        JSON.stringify({
          event:
            "WEBHOOK_SECRET_REJECTED"
        })
      );


      return new Response(
        "Unauthorized",
        {
          status: 401
        }
      );
    }
  }


  let body;

  try {

    body =
      await request.json();

  } catch {

    return Response.json(
      {
        ok: false,
        error:
          "Invalid JSON."
      },
      {
        status: 400
      }
    );
  }


  const updateId =
    body?.update_id;


  if (
    await isDuplicateUpdate(
      kv,
      env,
      updateId
    )
  ) {

    return Response.json({
      ok: true,
      duplicate: true
    });
  }


  /*
    Bale channel update.
  */

  const message =
    body?.channel_post;


  if (!message) {

    return Response.json({
      ok: true,
      ignored: true
    });
  }


  const expectedSource =
    sourceChatId(env);


  if (
    expectedSource &&
    String(
      message.chat.id
    ) !==
      expectedSource
  ) {

    console.warn(
      JSON.stringify({
        event:
          "SOURCE_CHAT_MISMATCH",

        expected:
          expectedSource,

        received:
          String(
            message.chat.id
          )
      })
    );


    return Response.json({
      ok: true,

      ignored: true,

      reason:
        "source_chat_mismatch"
    });
  }


  /*
    Album
  */

  if (
    message.media_group_id
  ) {

    const album =
      await addAlbumMessage(
        env,
        kv,
        message
      );


    return Response.json({
      ok: true,

      queued:
        "album",

      albumId:
        album.id,

      messageId:
        message.message_id
    });
  }


  /*
    Normal message
  */

  const item =
    await enqueueMessage(
      env,
      kv,
      message
    );


  return Response.json({
    ok: true,

    queued:
      "message",

    queueId:
      item.id
  });
}


/* =========================================================
   RETRY
========================================================= */

function calculateBackoff(
  retryCount
) {

  const base =
    60;

  const max =
    3600;

  const exponential =
    Math.min(
      max,
      base *
      Math.pow(
        2,
        retryCount
      )
    );

  const jitter =
    Math.floor(
      Math.random() *
      30
    );

  return (
    exponential +
    jitter
  );
}


/* =========================================================
   DLQ
========================================================= */

async function moveToDLQ(
  env,
  kv,
  item,
  error
) {

  const record = {

    ...item,

    status:
      "dead",

    failedAt:
      nowMs(),

    lastError:
      error?.message ||
      String(error)
  };


  await kvPutJSON(
    kv,
    dlqKey(
      item.id
    ),
    record,
    config(env)
      .DLQ_TTL_SEC
  );


  await deleteQueueItem(
    kv,
    item.id
  );
}


/* =========================================================
   PROCESS ONE QUEUE ITEM
========================================================= */

async function processQueueItem(
  env,
  kv,
  item
) {

  try {

    await copyQueueItem(
      env,
      item
    );


    await deleteQueueItem(
      kv,
      item.id
    );


    return {
      ok: true
    };

  } catch (error) {

    const retryCount =
      Number(
        item.retryCount
      ) || 0;


    if (
      retryCount >=
      config(env)
        .MAX_RETRIES
    ) {

      await moveToDLQ(
        env,
        kv,
        item,
        error
      );


      return {
        ok: false,
        dead: true,
        error:
          error?.message ||
          String(error)
      };
    }


    item.retryCount =
      retryCount + 1;


    item.status =
      "retry";


    item.lastError =
      error?.message ||
      String(error);


    item.nextAttemptAt =
      nowMs() +
      calculateBackoff(
        item.retryCount
      ) *
      1000;


    await saveQueueItem(
      env,
      kv,
      item
    );


    return {
      ok: false,
      retry: true,
      error:
        error?.message ||
        String(error)
    };
  }
}


/* =========================================================
   STATUS
========================================================= */

async function buildStatus(
  env,
  kv
) {

  const scheduler =
    await getScheduler(
      kv
    );


  const queue =
    await listQueue(
      env,
      kv
    );


  const dlq =
    await kv.list({
      prefix: "dlq:",
      limit: 100
    });


  return {

    ok: true,

    version:
      VERSION,

    queueLength:
      queue.length,

    dlqLength:
      dlq.keys.length,

    scheduler,

    sourceChatId:
      sourceChatId(env),

    targetChatId:
      targetChatIdFromEnv(
        env
      ),

    time:
      iso()
  };
}


/* =========================================================
   BALE REPORT
========================================================= */

async function sendBaleReport(
  env,
  text
) {

  const target =
  env.BALE_REPORT_CHAT_ID ||
  env.ADMIN_ID ||
    targetChatIdFromEnv(
      env
    );

  if (!target) {
    throw new Error(
      "No target configured for Bale report."
    );
  }


  return await telegramAPI(
    env,
    "sendMessage",
    {
      chat_id:
        target,

      text
    }
  );
}


/* =========================================================
   HOURLY REPORT
========================================================= */

async function maybeSendHourlyReport(
  env,
  kv,
  scheduler
) {

  const now =
    nowMs();


  const interval =
    config(env)
      .REPORT_INTERVAL_SEC *
    1000;


  if (
    scheduler.lastReportAt &&
    (
      now -
      scheduler.lastReportAt
    ) <
      interval
  ) {

    return false;
  }


  const queue =
    await listQueue(
      env,
      kv
    );


  const text = [

    "📊 گزارش وضعیت mynote_bot",

    ``,

    `🕐 زمان: ${iso()}`,

    `📦 صف: ${queue.length}`,

    `📤 ارسال‌شده: ${scheduler.sent || 0}`,

    `❌ ناموفق: ${scheduler.failed || 0}`,

    `⏭ ارسال بعدی: ${
      scheduler.nextSendAt
        ? iso(
            scheduler.nextSendAt
          )
        : "—"
    }`,

    ``,

    `🔧 Cron: ${
      scheduler.lastCron ||
      "—"
    }`,

    `🟢 Version: ${VERSION}`,

    ``,

    scheduler.lastError
      ? `⚠️ آخرین خطا:\n${scheduler.lastError}`
      : `✅ آخرین وضعیت خطا: ندارد`

  ].join("\n");


  try {

    await sendBaleReport(
      env,
      text
    );


    scheduler.lastReportAt =
      now;


    await saveScheduler(
      kv,
      scheduler
    );


    console.log(
      JSON.stringify({
        event:
          "HOURLY_REPORT_SENT"
      })
    );


    return true;

  } catch (error) {

    console.error(
      JSON.stringify({
        event:
          "BALE_REPORT_ERROR",

        error:
          error?.message ||
          String(error)
      })
    );


    return false;
  }
}


/* =========================================================
   CRON PROCESSOR
========================================================= */

async function processCron(
  controller,
  env
) {

  const kv =
    requireKV(env);


  let finalizedAlbums =
    0;


  try {

    finalizedAlbums =
      await finalizeAlbums(
        env,
        kv
      );

  } catch (error) {

    console.error(
      JSON.stringify({
        event:
          "ALBUM_FINALIZE_ERROR",

        error:
          error?.message ||
          String(error)
      })
    );
  }


  const lockToken =
    await acquireLock(
      kv,
      env
    );


  if (!lockToken) {

    console.log(
      JSON.stringify({
        event:
          "CRON_SKIPPED_LOCKED"
      })
    );

    return;
  }


  try {

    let scheduler =
      await getScheduler(
        kv
      );


    scheduler.lastCronAt =
      nowMs();


    scheduler.lastCron =
      controller?.cron ||
      "* * * * *";


    await saveScheduler(
      kv,
      scheduler
    );


    await maybeSendHourlyReport(
      env,
      kv,
      scheduler
    );


    scheduler =
      await getScheduler(
        kv
      );


    const queue =
      await listQueue(
        env,
        kv
      );


    if (
      queue.length === 0
    ) {

      scheduler.nextSendAt =
        0;


      await saveScheduler(
        kv,
        scheduler
      );


      console.log(
        JSON.stringify({
          event:
            "CRON_IDLE",

          finalizedAlbums
        })
      );


      return;
    }


    if (
      !scheduler.nextSendAt ||
      scheduler.nextSendAt <= 0
    ) {

      const delay =
        randomDelaySeconds(
          env
        );


      scheduler.nextSendAt =
        nowMs() +
        delay * 1000;


      await saveScheduler(
        kv,
        scheduler
      );


      console.log(
        JSON.stringify({
          event:
            "NEXT_SEND_SCHEDULED",

          delay,

          nextSendAt:
            scheduler.nextSendAt
        })
      );


      return;
    }


    if (
      nowMs() <
      scheduler.nextSendAt
    ) {

      return;
    }


    const candidate =
      queue.find(
        item => {

          if (
            item.status ===
            "pending"
          ) {
            return true;
          }

          if (
            item.status ===
            "retry"
          ) {

            return (
              (
                Number(
                  item.nextAttemptAt
                ) || 0
              ) <=
              nowMs()
            );
          }

          return false;
        }
      );


    if (!candidate) {

      scheduler.nextSendAt =
        nowMs() +
        randomDelaySeconds(
          env
        ) *
        1000;


      await saveScheduler(
        kv,
        scheduler
      );


      return;
    }


    candidate.status =
      "processing";


    candidate.processingAt =
      nowMs();


    await saveQueueItem(
      env,
      kv,
      candidate
    );


    const result =
      await processQueueItem(
        env,
        kv,
        candidate
      );


    scheduler =
      await getScheduler(
        kv
      );


    if (result.ok) {

      scheduler.sent =
        (
          Number(
            scheduler.sent
          ) || 0
        ) + 1;

    } else {

      scheduler.failed =
        (
          Number(
            scheduler.failed
          ) || 0
        ) + 1;

      scheduler.lastError =
        result.error;
    }


    scheduler.lastSendAt =
      nowMs();


    scheduler.nextSendAt =
      nowMs() +
      randomDelaySeconds(
        env
      ) *
      1000;


    await saveScheduler(
      kv,
      scheduler
    );


  } finally {

    await releaseLock(
      kv,
      lockToken
    );
  }
}


/* =========================================================
   ADMIN AUTHENTICATION
========================================================= */

function isAdmin(
  request,
  env
) {

  const configured =
    env.ADMIN_KEY;


  if (!configured) {
    return false;
  }


  const auth =
    request.headers.get(
      "Authorization"
    );


  if (
    auth ===
    `Bearer ${configured}`
  ) {
    return true;
  }


  const url =
    new URL(
      request.url
    );


  const key =
    url.searchParams.get(
      "key"
    );


  return key ===
    configured;
}


/* =========================================================
   ADMIN RESET
========================================================= */

async function adminResetScheduler(
  env,
  kv
) {

  const scheduler = {

    nextSendAt:
      0,

    lastSendAt:
      0,

    lastReportAt:
      0,

    lastCronAt:
      0,

    lastCron:
      "",

    sent:
      0,

    failed:
      0
  };


  await saveScheduler(
    kv,
    scheduler
  );


  return {
    ok: true,
    scheduler
  };
}


/* =========================================================
   ADMIN REQUEUE DLQ
========================================================= */

async function adminRequeueDLQ(
  env,
  kv
) {

  const list =
    await kv.list({
      prefix:
        "dlq:",
      limit: 1000
    });


  let count = 0;


  for (
    const key of
    list.keys
  ) {

    const item =
      await kvGetJSON(
        kv,
        key.name
      );


    if (!item) {
      continue;
    }


    item.status =
      "pending";


    item.retryCount =
      0;


    item.nextAttemptAt =
      0;


    item.lastError =
      null;


    await saveQueueItem(
      env,
      kv,
      item
    );


    await kvDelete(
      kv,
      key.name
    );


    count++;
  }


  return {
    ok: true,
    requeued:
      count
  };
}


/* =========================================================
   ADMIN: SET BALE WEBHOOK
========================================================= */

async function adminSetWebhook(
  request,
  env
) {

  /*
    Prefer explicitly configured public URL.
    Otherwise derive it from the request
    that reached this Worker.

    This means PUBLIC_WORKER_URL is optional.
  */

  const requestUrl =
    new URL(
      request.url
    );


  const publicUrl =
    env.PUBLIC_WORKER_URL ||
    requestUrl.origin;


  const secret =
    env.BALE_WEBHOOK_SECRET ||
    env.TELEGRAM_WEBHOOK_SECRET;


  const webhookUrl =
    publicUrl.replace(
      /\/$/,
      ""
    ) +
    "/webhook";


  const payload = {

    url:
      webhookUrl,

    allowed_updates:
      [
        "channel_post"
      ],

    drop_pending_updates:
      false
  };


  if (secret) {

    payload.secret_token =
      secret;
  }


  const result =
    await telegramAPI(
      env,
      "setWebhook",
      payload
    );


  return {

    ok: true,

    webhookUrl,

    bale:
      result
  };
}


/* =========================================================
   ADMIN: GET BALE WEBHOOK INFO
========================================================= */

async function adminWebhookInfo(
  env
) {

  const result =
    await telegramAPI(
      env,
      "getWebhookInfo",
      {}
    );


  return {

    ok: true,

    bale:
      result
  };
}


/* =========================================================
   FETCH HANDLER
========================================================= */

export default {

  async fetch(
    request,
    env,
    ctx
  ) {

    const url =
      new URL(
        request.url
      );


    const path =
      url.pathname;


    /* =====================================================
       HEALTH
    ===================================================== */

    if (
      path ===
      "/health"
    ) {

      return Response.json({

        ok: true,

        version:
          VERSION,

        time:
          iso()
      });
    }


    /* =====================================================
       BALE WEBHOOK
    ===================================================== */

    if (
      path === "/webhook" ||
      path === "/telegram/webhook"
    ) {

      if (
        request.method !==
        "POST"
      ) {

        return new Response(
          "Method Not Allowed",
          {
            status: 405
          }
        );
      }


      try {

        return await
          handleTelegramUpdate(
            request,
            env
          );

      } catch (error) {

        console.error(
          JSON.stringify({

            event:
              "WEBHOOK_PROCESSING_ERROR",

            error:
              error?.message ||
              String(error),

            stack:
              error?.stack ||
              null
          })
        );


        return Response.json(
          {

            ok: false,

            error:
              "Webhook processing failed."

          },
          {
            status: 500
          }
        );
      }
    }


    /* =====================================================
       ADMIN WEBHOOK INFO
    ===================================================== */

    if (
      path ===
      "/admin/webhook-info"
    ) {

      if (
        !isAdmin(
          request,
          env
        )
      ) {

        return new Response(
          "Unauthorized",
          {
            status: 401
          }
        );
      }


      try {

        const result =
          await adminWebhookInfo(
            env
          );


        return Response.json(
          result
        );

      } catch (error) {

        return Response.json(
          {

            ok: false,

            error:
              error?.message ||
              String(error)

          },
          {
            status: 500
          }
        );
      }
    }


    /* =====================================================
       ADMIN SET WEBHOOK
    ===================================================== */

    if (
      path ===
      "/admin/set-webhook"
    ) {

      if (
        !isAdmin(
          request,
          env
        )
      ) {

        return new Response(
          "Unauthorized",
          {
            status: 401
          }
        );
      }


      try {

        const result =
          await adminSetWebhook(
            request,
            env
          );


        return Response.json(
          result
        );

      } catch (error) {

        return Response.json(
          {

            ok: false,

            error:
              error?.message ||
              String(error)

          },
          {
            status: 500
          }
        );
      }
    }


    /* =====================================================
       ADMIN STATUS
    ===================================================== */

    if (
      path ===
      "/admin/status"
    ) {

      if (
        !isAdmin(
          request,
          env
        )
      ) {

        return new Response(
          "Unauthorized",
          {
            status: 401
          }
        );
      }


      try {

        const kv =
          requireKV(
            env
          );


        const status =
          await buildStatus(
            env,
            kv
          );


        return Response.json(
          status
        );

      } catch (error) {

        return Response.json(
          {

            ok: false,

            error:
              error?.message ||
              String(error)

          },
          {
            status: 500
          }
        );
      }
    }


    /* =====================================================
       ADMIN RESET
    ===================================================== */

    if (
      path ===
      "/admin/reset"
    ) {

      if (
        !isAdmin(
          request,
          env
        )
      ) {

        return new Response(
          "Unauthorized",
          {
            status: 401
          }
        );
      }


      try {

        const kv =
          requireKV(
            env
          );


        const result =
          await adminResetScheduler(
            env,
            kv
          );


        return Response.json(
          result
        );

      } catch (error) {

        return Response.json(
          {

            ok: false,

            error:
              error?.message ||
              String(error)

          },
          {
            status: 500
          }
        );
      }
    }


    /* =====================================================
       ADMIN REQUEUE DLQ
    ===================================================== */

    if (
      path ===
      "/admin/requeue-dlq"
    ) {

      if (
        !isAdmin(
          request,
          env
        )
      ) {

        return new Response(
          "Unauthorized",
          {
            status: 401
          }
        );
      }


      try {

        const kv =
          requireKV(
            env
          );


        const result =
          await adminRequeueDLQ(
            env,
            kv
          );


        return Response.json(
          result
        );

      } catch (error) {

        return Response.json(
          {

            ok: false,

            error:
              error?.message ||
              String(error)

          },
          {
            status: 500
          }
        );
      }
    }


    /* =====================================================
       ROOT
    ===================================================== */

    if (
      path ===
      "/"
    ) {

      return Response.json({

        ok: true,

        service:
          "mynote_bot",

        version:
          VERSION,

        architecture:
          "V14 Hybrid Bale",

        cron:
          "* * * * *",

        sendInterval:
          "3–10 minutes random",

        queue:
          "KV independent queue",

        retry:
          "exponential backoff",

        dlq:
          true,

        albumSupport:
          true,

        hourlyBaleReport:
          true,

        webhookEndpoint:
          "/webhook",

        legacyWebhookEndpoint:
          "/telegram/webhook",

        webhookSetup:
          "/admin/set-webhook",

        webhookInfo:
          "/admin/webhook-info",

        statusEndpoint:
          "/admin/status"
      });
    }


    return new Response(
      "Not Found",
      {
        status: 404
      }
    );
  },


  /* =======================================================
     CRON
  ======================================================= */

  async scheduled(
    controller,
    env,
    ctx
  ) {

    try {

      await processCron(
        controller,
        env
      );

    } catch (error) {

      console.error(
        JSON.stringify({

          event:
            "SCHEDULED_FATAL_ERROR",

          version:
            VERSION,

          cron:
            controller?.cron,

          scheduledTime:
            controller?.scheduledTime,

          error:
            error?.message ||
            String(error),

          stack:
            error?.stack ||
            null
        })
      );


      try {

        controller?.noRetry?.();

      } catch {
        // ignored
      }
    }
  }
};