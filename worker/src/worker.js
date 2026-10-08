/**
 * Hubstaff clock in/out -> ClickUp chat, as a Cloudflare Worker.
 *
 * Two properties matter, and they are separate problems:
 *
 * 1. NOTHING IS LOST. Every tick re-reads a wide window and skips events it has
 *    already posted, so a late arrival, a missed tick or a restart heals on the
 *    next pass. An incremental high-water mark cannot do this: an event that
 *    becomes visible after the mark passes its occurred_at is gone for good.
 *
 * 2. NOTHING IS POSTED TWICE. Cron triggers are at-least-once and nothing
 *    serialises them, so two invocations can run concurrently. The first version
 *    of this Worker kept state in KV and did read -> post -> write, which is a
 *    lost update: both invocations read before either wrote, both saw the event
 *    as unposted, and both posted. Real duplicates followed, milliseconds apart.
 *
 *    KV cannot fix that - it has no compare-and-set. D1 can: the event id is a
 *    PRIMARY KEY, so `INSERT OR IGNORE` is an atomic claim. Exactly one caller
 *    gets changes == 1 and posts; everyone else gets 0 and skips.
 *
 * Claiming before posting risks the opposite failure - a claim whose post never
 * happened would never retry - so a claim is a lease: rows carry sent=0 until the
 * post succeeds, a failed post releases the row immediately, and a claim left
 * stranded by a dead invocation is retaken after STALE_CLAIM_MS.
 *
 * FAST PATH. Hubstaff's timer.start / timer.stop webhook wakes sync() at once
 * instead of waiting for the next minute. It deliberately does not post from the
 * webhook payload: a delivery's id is a UUID unrelated to the tracking_states id,
 * so posting from it would bypass the claim and race the cron into a duplicate.
 * Waking sync() means both paths take the same INSERT OR IGNORE claim, and the
 * cron stays the safety net for any delivery Hubstaff drops.
 *
 * Bindings: D1 database DB, KV namespace SYNC_STATE (only to migrate off KV once)
 * Secrets:  HUBSTAFF_PERSONAL_ACCESS_TOKEN, CLICKUP_API_TOKEN
 *           TRIGGER_TOKEN (optional, enables POST /run and POST /webhook/register)
 *           WEBHOOK_KEY (optional, enables the webhook; part of its target URL)
 */

const HUBSTAFF_ORG_ID = 482654;
const CLICKUP_WORKSPACE_ID = "90161343471";
const CLICKUP_CHANNEL_ID = "2kz0huzf-2076";

const LOOKBACK_MINUTES = 360;
const PAGE_LIMIT = 100;

// How long another invocation's claim is respected before we assume it died
// mid-post and take the event over. Longer than any plausible ClickUp call.
const STALE_CLAIM_MS = 120_000;

// Rows older than this are pruned; only ever read back within LOOKBACK_MINUTES.
const RETAIN_DAYS = 7;

// A webhook can arrive before the tracking state it announces is readable from the
// API. Retry sync() on these offsets (ms) until it claims something; the cron
// catches anything still invisible after the last one.
const WEBHOOK_SYNC_DELAYS_MS = [0, 3_000, 8_000, 15_000];

const WEBHOOK_EVENTS = ["timer.start", "timer.stop"];
const WEBHOOK_PATH = "/hubstaff/webhook";

// Hubstaff's API sits behind Cloudflare and blocks requests without a browser-like UA.
const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS posted_events (
     id INTEGER PRIMARY KEY,
     sent INTEGER NOT NULL DEFAULT 0,
     claimed_at INTEGER NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS member_names (
     user_id INTEGER PRIMARY KEY,
     name TEXT NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS meta (
     key TEXT PRIMARY KEY,
     value TEXT NOT NULL
   )`,
];

const isoZ = (d) => d.toISOString().replace(/\.\d{3}Z$/, "Z");

const hhmm = (date, timeZone) =>
  new Intl.DateTimeFormat("en-GB", { timeZone, hour: "2-digit", minute: "2-digit", hour12: false }).format(date);

// Run every tick rather than caching per isolate. CREATE TABLE IF NOT EXISTS on an
// existing table writes nothing, so the cost is a few milliseconds, and caching it
// would silently skip creation for any isolate that outlived the schema.
async function ensureSchema(env) {
  await env.DB.batch(SCHEMA.map((sql) => env.DB.prepare(sql)));
}

async function hubstaffRequest(env, method, path, { params, body } = {}) {
  const url = new URL(`https://api.hubstaff.com/v2${path}`);
  for (const [k, v] of Object.entries(params || {})) url.searchParams.set(k, v);
  const headers = {
    Authorization: `Bearer ${env.HUBSTAFF_PERSONAL_ACCESS_TOKEN}`,
    Accept: "application/json",
    "User-Agent": USER_AGENT,
  };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const res = await fetch(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  if (!res.ok) throw new Error(`Hubstaff ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.status === 204 ? null : res.json();
}

const hubstaffGet = (env, path, params) => hubstaffRequest(env, "GET", path, { params });

async function clickupSend(env, content) {
  const res = await fetch(
    `https://api.clickup.com/api/v3/workspaces/${CLICKUP_WORKSPACE_ID}/chat/channels/${CLICKUP_CHANNEL_ID}/messages`,
    {
      method: "POST",
      headers: {
        Authorization: env.CLICKUP_API_TOKEN,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({ content, content_format: "text/md", type: "message" }),
    },
  );
  if (!res.ok) throw new Error(`ClickUp ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

async function fetchEvents(env, startDt, stopDt) {
  const events = [];
  const cursorsSeen = new Set();
  let pageStartId = null;

  for (;;) {
    const params = {
      organization_id: HUBSTAFF_ORG_ID,
      "occurred[start]": isoZ(startDt),
      "occurred[stop]": isoZ(stopDt),
      page_limit: PAGE_LIMIT,
    };
    if (pageStartId !== null) params.page_start_id = pageStartId;

    const body = await hubstaffGet(env, `/organizations/${HUBSTAFF_ORG_ID}/tracking_states`, params);
    const batch = body.tracking_states || [];
    events.push(...batch);

    let nextId = body.pagination && body.pagination.next_page_start_id;
    if (!nextId && batch.length === PAGE_LIMIT) {
      // Re-read the boundary row rather than stepping past it: whether page_start_id
      // is inclusive is undocumented, and a repeat is free where a skip is the bug.
      nextId = Math.max(...batch.map((e) => e.id));
    }
    if (!nextId || cursorsSeen.has(nextId)) break;
    cursorsSeen.add(nextId);
    pageStartId = nextId;
  }
  return events;
}

function describe(event, name) {
  const at = new Date(event.occurred_at);
  const started = event.type === "start";
  return (
    `${started ? "\u{1F7E2}" : "\u{1F534}"} **${started ? "Clocked In" : "Clocked Out"}** — ${name}\n` +
    `\u{1F550} ${hhmm(at, "Europe/Stockholm")} Stockholm · ${hhmm(at, "Asia/Manila")} Manila`
  );
}

/** Mark ids as already handled without posting. Used for seeding and KV migration. */
async function markHandled(env, ids, nowMs) {
  for (let i = 0; i < ids.length; i += 50) {
    const chunk = ids.slice(i, i + 50);
    await env.DB.batch(
      chunk.map((id) =>
        env.DB.prepare("INSERT OR IGNORE INTO posted_events (id, sent, claimed_at) VALUES (?, 1, ?)").bind(id, nowMs),
      ),
    );
  }
}

/**
 * One-time handover. Returns true if this tick should post nothing.
 *
 * Carries the ids KV already knew about into D1 so the switch loses nothing. With
 * no KV state to import it falls back to seeding from the current window, because
 * an empty table plus a 6h lookback would otherwise dump hours of backlog at once.
 */
async function bootstrapIfNeeded(env, windowEvents, nowMs) {
  const done = await env.DB.prepare("SELECT value FROM meta WHERE key = 'bootstrapped'").first();
  if (done) return false;

  let imported = 0;
  if (env.SYNC_STATE) {
    const state = await env.SYNC_STATE.get("sync-state", "json");
    if (state && Array.isArray(state.ids) && state.ids.length) {
      await markHandled(env, state.ids, nowMs);
      imported = state.ids.length;
    }
  }
  if (!imported) await markHandled(env, windowEvents.map((e) => e.id), nowMs);

  await env.DB.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('bootstrapped', ?)")
    .bind(new Date(nowMs).toISOString())
    .run();

  console.log(`bootstrapped: ${imported ? `imported ${imported} ids from KV` : `seeded ${windowEvents.length} from window`}`);
  return true;
}

async function nameFor(env, userId, cache) {
  const key = String(userId);
  if (cache.has(key)) return cache.get(key);

  const row = await env.DB.prepare("SELECT name FROM member_names WHERE user_id = ?").bind(userId).first();
  if (row) {
    cache.set(key, row.name);
    return row.name;
  }
  const name = (await hubstaffGet(env, `/users/${key}`)).user.name;
  await env.DB.prepare("INSERT OR REPLACE INTO member_names (user_id, name) VALUES (?, ?)").bind(userId, name).run();
  cache.set(key, name);
  return name;
}

export async function sync(env) {
  await ensureSchema(env);

  const now = new Date();
  const nowMs = now.getTime();
  const since = new Date(nowMs - LOOKBACK_MINUTES * 60_000);

  const events = (await fetchEvents(env, since, now))
    .filter((e) => e.type === "start" || e.type === "stop")
    .sort((a, b) => new Date(a.occurred_at) - new Date(b.occurred_at) || a.id - b.id);

  if (await bootstrapIfNeeded(env, events, nowMs)) {
    return { bootstrapped: true, posted: 0 };
  }
  if (!events.length) return { posted: 0, skipped: 0, failures: 0 };

  const placeholders = events.map(() => "?").join(",");
  const { results } = await env.DB.prepare(
    `SELECT id, sent, claimed_at FROM posted_events WHERE id IN (${placeholders})`,
  )
    .bind(...events.map((e) => e.id))
    .all();
  const known = new Map((results || []).map((r) => [r.id, r]));

  const names = new Map();
  let posted = 0;
  let skipped = 0;
  let failures = 0;

  for (const event of events) {
    const row = known.get(event.id);
    if (row && row.sent === 1) continue;

    // Atomically take ownership. Losing here is normal and correct: it means a
    // concurrent invocation owns this event, and it is the duplicate not happening.
    let owned = false;
    if (!row) {
      const r = await env.DB.prepare(
        "INSERT OR IGNORE INTO posted_events (id, sent, claimed_at) VALUES (?, 0, ?)",
      )
        .bind(event.id, nowMs)
        .run();
      owned = r.meta.changes === 1;
    } else if (nowMs - row.claimed_at > STALE_CLAIM_MS) {
      // Claimed but never sent, and stale - whoever held it died mid-post.
      const r = await env.DB.prepare(
        "UPDATE posted_events SET claimed_at = ? WHERE id = ? AND sent = 0 AND claimed_at = ?",
      )
        .bind(nowMs, event.id, row.claimed_at)
        .run();
      owned = r.meta.changes === 1;
    }

    if (!owned) {
      skipped++;
      continue;
    }

    try {
      await clickupSend(env, describe(event, await nameFor(env, event.user_id, names)));
    } catch (err) {
      // Release the claim so the next tick retries at once instead of waiting out
      // STALE_CLAIM_MS. One bad post must not strand the rest of the batch.
      failures++;
      await env.DB.prepare("DELETE FROM posted_events WHERE id = ? AND sent = 0").bind(event.id).run();
      console.log(`post failed for event ${event.id} (user_id=${event.user_id}): ${err && err.message}`);
      continue;
    }

    await env.DB.prepare("UPDATE posted_events SET sent = 1 WHERE id = ?").bind(event.id).run();
    posted++;
    // Deliberately not logging names or message bodies.
    console.log(`posted ${event.type} event ${event.id} (user_id=${event.user_id})`);
  }

  if (posted) {
    await env.DB.prepare("DELETE FROM posted_events WHERE claimed_at < ?")
      .bind(nowMs - RETAIN_DAYS * 86_400_000)
      .run();
  }
  return { posted, skipped, failures };
}

// ---------------------------------------------------------------- webhook
// Spec: https://developer.hubstaff.com/webhooks
//   handshake  empty-body POST carrying X-Hook-Secret; reply 200 echoing it.
//              Echoing makes the webhook active directly - no activate call.
//   delivery   JSON POST; X-Hook-Signature is hex HMAC-SHA256(raw body, secret).
//              2xx is success, 5xx/timeouts are retried, 404/410 disable the hook.

async function getMeta(env, key) {
  const row = await env.DB.prepare("SELECT value FROM meta WHERE key = ?").bind(key).first();
  return row ? row.value : null;
}

const setMeta = (env, key, value) =>
  env.DB.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)").bind(key, value).run();

function hexToBytes(hex) {
  if (typeof hex !== "string" || !/^(?:[0-9a-fA-F]{2})+$/.test(hex)) return null;
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/** Constant-time check of X-Hook-Signature: subtle.verify compares without leaking timing. */
export async function verifySignature(secret, rawBody, signatureHex) {
  const sig = hexToBytes(signatureHex);
  if (!secret || !sig) return false;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"],
  );
  return crypto.subtle.verify("HMAC", key, sig, rawBody);
}

/** Run sync() now, retrying briefly in case the API has not caught up with the push. */
export async function webhookSync(env, delays = WEBHOOK_SYNC_DELAYS_MS) {
  let waited = 0;
  for (const at of delays) {
    if (at > waited) await new Promise((r) => setTimeout(r, at - waited));
    waited = at;
    const r = await sync(env);
    // posted: we got it. skipped: a concurrent tick holds the claim. Either way done.
    if (r.posted || r.skipped || r.bootstrapped) return r;
  }
  return { posted: 0 };
}

async function handleWebhook(request, env, ctx) {
  // The key in the target URL is what stops anyone else from completing a
  // handshake and installing an HMAC secret of their choosing. 403, never 404:
  // Hubstaff disables a webhook whose target answers 404.
  const key = new URL(request.url).searchParams.get("key");
  if (!env.WEBHOOK_KEY || key !== env.WEBHOOK_KEY) return new Response("Forbidden", { status: 403 });

  await ensureSchema(env);

  const handshake = request.headers.get("X-Hook-Secret");
  if (handshake) {
    await setMeta(env, "webhook_secret", handshake);
    console.log("webhook handshake: secret stored");
    return new Response(null, { status: 200, headers: { "X-Hook-Secret": handshake } });
  }

  const raw = await request.arrayBuffer();
  const secret = await getMeta(env, "webhook_secret");
  if (!(await verifySignature(secret, raw, request.headers.get("X-Hook-Signature")))) {
    console.log("webhook rejected: bad signature");
    return new Response("Unauthorized", { status: 401 });
  }

  let delivery;
  try {
    delivery = JSON.parse(new TextDecoder().decode(raw));
  } catch {
    return new Response("Bad Request", { status: 400 });
  }
  if (WEBHOOK_EVENTS.includes(delivery.event)) {
    console.log(`webhook ${delivery.event} ${delivery.id}`);
    ctx.waitUntil(
      Promise.all([setMeta(env, "webhook_last_delivery", new Date().toISOString()), webhookSync(env)]).then(
        ([, r]) => console.log("webhook sync ok", JSON.stringify(r)),
        (e) => console.log("webhook sync failed:", e && e.message),
      ),
    );
  }
  return new Response(null, { status: 200 });
}

/**
 * Create the org webhook pointing at this Worker. Hubstaff then sends the
 * handshake, which handleWebhook answers. Refuses if one is already registered
 * unless ?replace=1, which deletes the old one first - two live webhooks would
 * each overwrite the other's secret and fail every delivery.
 */
async function registerWebhook(request, env) {
  if (!env.WEBHOOK_KEY) return Response.json({ error: "set the WEBHOOK_KEY secret first" }, { status: 400 });
  await ensureSchema(env);
  const url = new URL(request.url);
  const existing = await getMeta(env, "webhook_id");
  if (existing) {
    if (url.searchParams.get("replace") !== "1") {
      return Response.json({ error: "already registered", webhook_id: existing }, { status: 409 });
    }
    try {
      await hubstaffRequest(env, "DELETE", `/webhooks/${existing}`);
    } catch (e) {
      console.log(`delete of old webhook ${existing} failed: ${e && e.message}`);
    }
  }
  const target = new URL(WEBHOOK_PATH, url.origin);
  target.searchParams.set("key", env.WEBHOOK_KEY);
  const created = await hubstaffRequest(env, "POST", `/organizations/${HUBSTAFF_ORG_ID}/webhooks`, {
    body: { events: WEBHOOK_EVENTS, target_url: target.toString() },
  });
  const id = created && (created.webhook ? created.webhook.id : created.id);
  if (id) await setMeta(env, "webhook_id", String(id));
  return Response.json({ webhook_id: id ?? null, response: created });
}

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(
      sync(env).then(
        (r) => console.log("sync ok", JSON.stringify(r)),
        (e) => console.log("sync failed:", e && e.message),
      ),
    );
  },

  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === WEBHOOK_PATH && request.method === "POST") {
      try {
        return await handleWebhook(request, env, ctx);
      } catch (e) {
        // 5xx so Hubstaff retries; the cron covers it meanwhile.
        console.log("webhook error:", e && e.message);
        return new Response("Error", { status: 500 });
      }
    }

    if (url.pathname === "/webhook/register" && request.method === "POST") {
      if (!env.TRIGGER_TOKEN || url.searchParams.get("token") !== env.TRIGGER_TOKEN) {
        return new Response("Forbidden", { status: 403 });
      }
      try {
        return await registerWebhook(request, env);
      } catch (e) {
        return Response.json({ error: e && e.message }, { status: 502 });
      }
    }

    if (url.pathname === "/health") {
      const missing = ["DB", "HUBSTAFF_PERSONAL_ACCESS_TOKEN", "CLICKUP_API_TOKEN"].filter((k) => !env[k]);
      if (missing.length) {
        return Response.json(
          { ok: false, missing, hint: "Worker -> Settings: DB is a D1 binding; the other two are Secrets." },
          { status: 500 },
        );
      }
      try {
        await ensureSchema(env);
        const boot = await env.DB.prepare("SELECT value FROM meta WHERE key = 'bootstrapped'").first();
        const counts = await env.DB.prepare(
          "SELECT COUNT(*) AS total, SUM(sent) AS sent FROM posted_events",
        ).first();
        return Response.json({
          ok: true,
          store: "d1",
          bootstrapped: boot ? boot.value : null,
          tracked_events: (counts && counts.total) || 0,
          sent_events: (counts && counts.sent) || 0,
          webhook: {
            enabled: Boolean(env.WEBHOOK_KEY),
            id: await getMeta(env, "webhook_id"),
            verified: Boolean(await getMeta(env, "webhook_secret")),
            last_delivery: await getMeta(env, "webhook_last_delivery"),
          },
        });
      } catch (e) {
        return Response.json({ ok: false, error: e && e.message }, { status: 500 });
      }
    }

    if (url.pathname === "/run" && request.method === "POST") {
      if (!env.TRIGGER_TOKEN || url.searchParams.get("token") !== env.TRIGGER_TOKEN) {
        return new Response("Forbidden", { status: 403 });
      }
      try {
        return Response.json(await sync(env));
      } catch (e) {
        return Response.json({ error: e && e.message }, { status: 500 });
      }
    }

    return new Response("Not found", { status: 404 });
  },
};
