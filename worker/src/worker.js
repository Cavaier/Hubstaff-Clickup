/**
 * Hubstaff clock in/out -> ClickUp chat, as a Cloudflare Worker.
 *
 * A port of scripts/hubstaff_clickup_sync.py, carrying over the property that
 * matters: the job is idempotent, not incremental. Every tick re-reads a wide
 * window and skips any event whose Hubstaff id it has already posted. Late
 * arrivals, missed ticks and restarts all heal on the next pass.
 *
 * Why this exists at all: the same poll on GitHub Actions cost a full workflow
 * run - queue, runner provisioning, checkout - for a fraction of a second of
 * work. At one dispatch a minute that has no headroom, and when GitHub slowed
 * down the backlog grew without bound. Here a tick is a cron trigger with no
 * provisioning in front of it.
 *
 * Free-plan budget (the limits this is shaped around):
 *   requests  100,000/day   - a 1-minute cron uses 1,440
 *   KV reads  100,000/day   - one per tick, so 1,440
 *   KV writes   1,000/day   - THE binding constraint. A tick only writes when
 *                             something actually changed, so writes track the
 *                             number of clock events (tens), not ticks. Do not
 *                             make this write unconditionally.
 *   CPU           10ms/req  - two JSON parses; the fetches are I/O, not CPU.
 *
 * Bindings: KV namespace SYNC_STATE
 * Secrets:  HUBSTAFF_PERSONAL_ACCESS_TOKEN, CLICKUP_API_TOKEN
 *           TRIGGER_TOKEN (optional, enables POST /run for testing)
 */

const HUBSTAFF_ORG_ID = 482654;
const CLICKUP_WORKSPACE_ID = "90161343471";
const CLICKUP_CHANNEL_ID = "2kz0huzf-2076";

// How far back each tick re-reads. Anything inside this survives an outage;
// anything older is gone. Cheap: a few events for a handful of members.
const LOOKBACK_MINUTES = 360;
const MAX_REMEMBERED_IDS = 1000;
const PAGE_LIMIT = 100;
const STATE_KEY = "sync-state";

// Hubstaff's API sits behind Cloudflare and blocks requests without a browser-like UA.
const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

const isoZ = (d) => d.toISOString().replace(/\.\d{3}Z$/, "Z");

const hhmm = (date, timeZone) =>
  new Intl.DateTimeFormat("en-GB", { timeZone, hour: "2-digit", minute: "2-digit", hour12: false }).format(date);

async function hubstaffGet(env, path, params) {
  const url = new URL(`https://api.hubstaff.com/v2${path}`);
  for (const [k, v] of Object.entries(params || {})) url.searchParams.set(k, v);
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${env.HUBSTAFF_PERSONAL_ACCESS_TOKEN}`,
      Accept: "application/json",
      "User-Agent": USER_AGENT,
    },
  });
  if (!res.ok) throw new Error(`Hubstaff ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

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
      // No documented cursor but a full page. Re-read the boundary row rather than
      // stepping past it - whether page_start_id is inclusive is undocumented, and the
      // id dedupe makes a repeat free whereas a skip is the bug this all exists to stop.
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

export async function sync(env) {
  const state = await env.SYNC_STATE.get(STATE_KEY, "json");

  // No state means seed, do not post: an empty set plus a 6h lookback would otherwise
  // dump hours of backlog into the channel in one go.
  const seeding = !state || !Array.isArray(state.ids);
  const posted = new Set(seeding ? [] : state.ids);
  const names = (state && state.names) || {};

  const now = new Date();
  const since = new Date(now.getTime() - LOOKBACK_MINUTES * 60_000);

  const events = (await fetchEvents(env, since, now))
    .filter((e) => e.type === "start" || e.type === "stop")
    .sort((a, b) => new Date(a.occurred_at) - new Date(b.occurred_at) || a.id - b.id);

  if (seeding) {
    const ids = events.map((e) => e.id).sort((a, b) => b - a).slice(0, MAX_REMEMBERED_IDS);
    await env.SYNC_STATE.put(STATE_KEY, JSON.stringify({ v: 2, ids, names, ts: isoZ(now) }));
    return { seeded: ids.length, posted: 0 };
  }

  let changed = false;
  let postedCount = 0;
  let failures = 0;

  for (const event of events) {
    if (posted.has(event.id)) continue;
    const uid = String(event.user_id);
    try {
      if (!names[uid]) {
        names[uid] = (await hubstaffGet(env, `/users/${uid}`)).user.name;
        changed = true;
      }
      await clickupSend(env, describe(event, names[uid]));
    } catch (err) {
      // One bad post must not strand the rest. The id stays unrecorded, so the next
      // tick retries it.
      failures++;
      console.log(`post failed for event ${event.id} (user_id=${uid}): ${err && err.message}`);
      continue;
    }
    posted.add(event.id);
    changed = true;
    postedCount++;
  }

  // Only write when something changed - see the KV write budget at the top.
  if (changed) {
    const ids = [...posted].sort((a, b) => b - a).slice(0, MAX_REMEMBERED_IDS);
    await env.SYNC_STATE.put(STATE_KEY, JSON.stringify({ v: 2, ids, names, ts: isoZ(now) }));
  }
  return { posted: postedCount, failures, remembered: posted.size };
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

  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/health") {
      // Report a misconfiguration as readable JSON. Reaching into a missing binding or
      // secret otherwise throws, and the Worker surfaces that as a bare "Error 1101"
      // with nothing to act on.
      const missing = ["SYNC_STATE", "HUBSTAFF_PERSONAL_ACCESS_TOKEN", "CLICKUP_API_TOKEN"]
        .filter((k) => !env[k]);
      if (missing.length) {
        return Response.json(
          { ok: false, missing, hint: "Worker -> Settings: SYNC_STATE is a KV namespace binding; the other two are Secrets." },
          { status: 500 },
        );
      }
      try {
        const state = await env.SYNC_STATE.get(STATE_KEY, "json");
        return Response.json({
          ok: true,
          seeded: Boolean(state && Array.isArray(state.ids)),
          last_state_write: (state && state.ts) || null,
          remembered_ids: (state && state.ids && state.ids.length) || 0,
        });
      } catch (e) {
        return Response.json({ ok: false, error: e && e.message }, { status: 500 });
      }
    }

    // Manual tick, for verifying a deploy without waiting for the cron.
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
