/**
 * Logic tests for the Worker. `node worker/test/test_worker.mjs`.
 *
 * No network and no Cloudflare: fetch is stubbed, and D1 is backed by a real
 * in-memory SQLite via node:sqlite so the claim semantics under test are the
 * actual SQL ones (INSERT OR IGNORE, changes) rather than a hand-written mock.
 */
import { DatabaseSync } from "node:sqlite";
import { createHmac } from "node:crypto";
import worker, { sync, webhookSync } from "../src/worker.js";

const yield_ = () => new Promise((r) => setImmediate(r));
const plain = (v) => (typeof v === "bigint" ? Number(v) : v);
const row = (r) => (r ? Object.fromEntries(Object.entries(r).map(([k, v]) => [k, plain(v)])) : r);

function makeD1() {
  const db = new DatabaseSync(":memory:");
  const prepare = (sql) => {
    let bound = [];
    const api = {
      bind(...a) { bound = a; return api; },
      async run() { await yield_(); return { success: true, meta: { changes: Number(db.prepare(sql).run(...bound).changes) } }; },
      async first() { await yield_(); return row(db.prepare(sql).get(...bound)) ?? null; },
      async all() { await yield_(); return { results: db.prepare(sql).all(...bound).map(row) }; },
    };
    return api;
  };
  return { prepare, async batch(stmts) { const o = []; for (const s of stmts) o.push(await s.run()); return o; } };
}

const ISO = (d) => d.toISOString().replace(/\.\d{3}Z$/, "Z");
const NOW = Date.now();
const ago = (s) => ISO(new Date(NOW - s * 1000));

let EVENTS = [
  { id: 101, occurred_at: ago(300), type: "start", user_id: 1 },
  { id: 102, occurred_at: ago(200), type: "stop", user_id: 2 },
  { id: 103, occurred_at: ago(60), type: "start", user_id: 2 },
];

let posts = [];
let clickupFailFor = new Set();
let clickupDelayMs = 0;

globalThis.fetch = async (url, opts = {}) => {
  const href = String(url);
  if (href.includes("/tracking_states")) return new Response(JSON.stringify({ tracking_states: EVENTS }), { status: 200 });
  if (href.includes("api.hubstaff.com/v2/users/")) {
    const uid = href.split("/").pop();
    return new Response(JSON.stringify({ user: { name: `User${uid}` } }), { status: 200 });
  }
  if (href.includes("api.clickup.com")) {
    const body = JSON.parse(opts.body).content;
    if (clickupDelayMs) await new Promise((r) => setTimeout(r, clickupDelayMs));
    for (const bad of clickupFailFor) if (body.includes(bad)) return new Response("boom", { status: 429 });
    posts.push(body);
    return new Response(JSON.stringify({ id: "m" }), { status: 200 });
  }
  throw new Error("unexpected fetch: " + href);
};

const env = (db, kv) => ({ DB: db, SYNC_STATE: kv, HUBSTAFF_PERSONAL_ACCESS_TOKEN: "x", CLICKUP_API_TOKEN: "y" });
const kvWith = (ids) => ({ async get() { return ids ? { v: 2, ids } : null; } });

let failed = false;
const expect = (c, m) => { console.log((c ? "  PASS  " : "  FAIL  ") + m); if (!c) failed = true; };

// ---------------------------------------------------------------- bootstrap
let db = makeD1(); posts = [];
let r = await sync(env(db, kvWith([101, 102])));
console.log("=== 1. bootstrap, importing from KV ===", JSON.stringify(r));
expect(posts.length === 0, "posts nothing while bootstrapping");
r = await sync(env(db, kvWith([101, 102])));
expect(posts.length === 1 && posts[0].includes("User2"), "next tick posts only the event KV did not know (103)");

db = makeD1(); posts = [];
r = await sync(env(db, null));
console.log("=== 2. bootstrap with no KV ===", JSON.stringify(r));
expect(posts.length === 0, "seeds from the window instead of dumping backlog");
await sync(env(db, null));
expect(posts.length === 0, "and stays quiet - all three were seeded");

// ---------------------------------------------------------------- normal + idempotency
db = makeD1(); posts = [];
await sync(env(db, kvWith([])));                 // bootstrap, empty KV import -> seeds window
await new Promise((r) => setTimeout(r, 5));
EVENTS = [...EVENTS, { id: 104, occurred_at: ago(10), type: "stop", user_id: 3 }];
posts = [];
r = await sync(env(db, null));
console.log("=== 3. a new event arrives ===", JSON.stringify(r));
expect(posts.length === 1 && posts[0].includes("User3"), "posts the new event");
posts = [];
r = await sync(env(db, null));
expect(posts.length === 0, "re-running posts nothing");

// ------------------------------------------------- THE BUG: concurrent ticks
db = makeD1(); posts = [];
await sync(env(db, null));                       // bootstrap/seed
EVENTS = [...EVENTS, { id: 201, occurred_at: ago(5), type: "start", user_id: 4 }];
posts = [];
clickupDelayMs = 25;                             // hold the post open so the two ticks overlap
const [a, b] = await Promise.all([sync(env(db, null)), sync(env(db, null))]);
clickupDelayMs = 0;
console.log("=== 4. two concurrent ticks ===", JSON.stringify(a), JSON.stringify(b));
const dupes = posts.filter((p) => p.includes("User4")).length;
expect(dupes === 1, `the contested event posts EXACTLY once (got ${dupes})`);
expect(a.posted + b.posted === 1, "exactly one tick claims it");
expect(a.skipped + b.skipped >= 1, "the loser records a skip rather than posting");

// ---------------------------------------------------------------- failure path
db = makeD1(); posts = [];
await sync(env(db, null));
EVENTS = [...EVENTS, { id: 301, occurred_at: ago(5), type: "start", user_id: 5 }];
posts = []; clickupFailFor = new Set(["User5"]);
r = await sync(env(db, null));
console.log("=== 5. a failing post ===", JSON.stringify(r));
expect(r.failures === 1 && posts.length === 0, "reports the failure and posts nothing");
clickupFailFor = new Set();
posts = [];
r = await sync(env(db, null));
expect(posts.length === 1, "the very next tick retries it - the claim was released, not stranded");

// ---------------------------------------------------------------- rendering
db = makeD1(); posts = [];
EVENTS = [{ id: 900, occurred_at: "2026-10-05T05:13:01Z", type: "start", user_id: 7 }];
await sync(env(db, kvWith([])));
EVENTS = [
  { id: 900, occurred_at: "2026-10-05T05:13:01Z", type: "start", user_id: 7 },
  { id: 901, occurred_at: "2026-10-04T22:51:15Z", type: "stop", user_id: 8 },
];
posts = [];
await sync(env(db, null));
console.log("=== 6. rendering ===");
for (const p of posts) console.log("  " + p.replace("\n", " / "));
expect(posts.includes("\u{1F534} **Clocked Out** — User8\n\u{1F550} 00:51 Stockholm · 06:51 Manila"),
  "clock-out renders byte-identical to the channel");

// ---------------------------------------------------------------- webhook
const sign = (secret, body) => createHmac("sha256", secret).update(body).digest("hex");
const hook = (path, headers = {}, body = "") =>
  new Request(`https://w.example${path}`, { method: "POST", headers, body: body || undefined });
const ctxStub = () => { const p = []; return { waitUntil: (x) => p.push(x), settle: () => Promise.all(p) }; };
const wenv = (db) => ({ ...env(db, null), WEBHOOK_KEY: "k1" });

db = makeD1(); posts = [];
EVENTS = [{ id: 500, occurred_at: ago(60), type: "start", user_id: 9 }];
await sync(wenv(db));                            // bootstrap/seed

let res = await worker.fetch(hook("/hubstaff/webhook?key=nope", { "X-Hook-Secret": "evil" }), wenv(db), ctxStub());
console.log("=== 7. webhook handshake ===");
expect(res.status === 403, "handshake without the URL key is refused (403, not 404)");
res = await worker.fetch(hook("/hubstaff/webhook?key=k1", { "X-Hook-Secret": "s3cret" }), wenv(db), ctxStub());
expect(res.status === 200 && res.headers.get("X-Hook-Secret") === "s3cret", "handshake echoes X-Hook-Secret with 200");

EVENTS = [...EVENTS, { id: 501, occurred_at: ago(2), type: "stop", user_id: 9 }];
const body = JSON.stringify({ id: "uuid-1", event: "timer.stop", payload: { user_id: 9 } });
let c = ctxStub();
res = await worker.fetch(hook("/hubstaff/webhook?key=k1", { "X-Hook-Signature": sign("wrong", body) }, body), wenv(db), c);
await c.settle();
console.log("=== 8. webhook delivery ===");
expect(res.status === 401 && posts.length === 0, "a bad signature is rejected with 401 and posts nothing");
res = await worker.fetch(hook("/hubstaff/webhook?key=k1", { "X-Hook-Signature": "zz" }, body), wenv(db), c);
expect(res.status === 401, "a malformed signature is rejected");
c = ctxStub();
res = await worker.fetch(hook("/hubstaff/webhook?key=k1", { "X-Hook-Signature": sign("s3cret", body) }, body), wenv(db), c);
await c.settle();
expect(res.status === 200 && posts.length === 1 && posts[0].includes("User9"), "a signed delivery posts the event at once");
c = ctxStub();
await worker.fetch(hook("/hubstaff/webhook?key=k1", { "X-Hook-Signature": sign("s3cret", body) }, body), wenv(db), c);
await c.settle();
expect(posts.length === 1, "a redelivery of the same push posts nothing more");

// The point of routing the webhook through sync(): it races the cron and still posts once.
EVENTS = [...EVENTS, { id: 502, occurred_at: ago(1), type: "start", user_id: 10 }];
posts = []; clickupDelayMs = 25;
const [w, t] = await Promise.all([webhookSync(wenv(db), [0]), sync(wenv(db))]);
clickupDelayMs = 0;
console.log("=== 9. webhook vs cron ===", JSON.stringify(w), JSON.stringify(t));
expect(posts.filter((p) => p.includes("User10")).length === 1, "webhook and cron racing post exactly once");

// Push arrives before the API shows the event: retry, then post.
EVENTS = EVENTS.filter((e) => e.id !== 503);
posts = [];
setTimeout(() => { EVENTS = [...EVENTS, { id: 503, occurred_at: ago(1), type: "stop", user_id: 11 }]; }, 15);
r = await webhookSync(wenv(db), [0, 40]);
console.log("=== 10. webhook before the API catches up ===", JSON.stringify(r));
expect(posts.length === 1 && posts[0].includes("User11"), "retries until the event is visible, then posts it");

console.log(failed ? "\nTESTS FAILED" : "\nALL TESTS PASSED");
process.exit(failed ? 1 : 0);
