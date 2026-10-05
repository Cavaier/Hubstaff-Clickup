/**
 * Logic tests for the Worker. `node worker/test/test_worker.mjs`.
 * No network, no Cloudflare, no tokens: fetch and KV are stubbed.
 */
import { sync } from "../src/worker.js";

const ISO = (d) => d.toISOString().replace(/\.\d{3}Z$/, "Z");
const NOW = Date.now();
const ago = (s) => ISO(new Date(NOW - s * 1000));

const EVENTS = [
  { id: 101, occurred_at: ago(300), type: "start", user_id: 1 },
  { id: 102, occurred_at: ago(200), type: "stop", user_id: 2 },
  { id: 103, occurred_at: ago(190), type: "start", user_id: 2 },
  { id: 104, occurred_at: ago(5), type: "start", user_id: 3 },
];

let posts = [];
let clickupFails = 0;

function makeKV() {
  return {
    store: new Map(), reads: 0, writes: 0,
    async get(k, type) {
      this.reads++;
      const v = this.store.get(k);
      return v == null ? null : type === "json" ? JSON.parse(v) : v;
    },
    async put(k, v) { this.writes++; this.store.set(k, v); },
  };
}

globalThis.fetch = async (url, opts = {}) => {
  const href = String(url);
  if (href.includes("/tracking_states")) {
    return new Response(JSON.stringify({ tracking_states: EVENTS }), { status: 200 });
  }
  if (href.includes("api.hubstaff.com/v2/users/")) {
    const uid = href.split("/").pop();
    return new Response(JSON.stringify({ user: { name: `User${uid}` } }), { status: 200 });
  }
  if (href.includes("api.clickup.com")) {
    if (clickupFails > 0) { clickupFails--; return new Response("rate limited", { status: 429 }); }
    posts.push(JSON.parse(opts.body).content);
    return new Response(JSON.stringify({ id: "m1" }), { status: 200 });
  }
  throw new Error("unexpected fetch: " + href);
};

const env = (kv) => ({
  SYNC_STATE: kv,
  HUBSTAFF_PERSONAL_ACCESS_TOKEN: "x",
  CLICKUP_API_TOKEN: "y",
});

let failed = false;
const expect = (cond, msg) => {
  console.log((cond ? "  PASS  " : "  FAIL  ") + msg);
  if (!cond) failed = true;
};

// 1. cold start
let kv = makeKV();
posts = [];
let r = await sync(env(kv));
console.log("=== 1. cold start ===", JSON.stringify(r));
expect(posts.length === 0, "posts nothing on a cold start");
expect(r.seeded === 4, "seeds every id in the window");
expect(kv.writes === 1, "writes state once to seed");

// 2. normal tick
posts = [];
kv.store.set("sync-state", JSON.stringify({ v: 2, ids: [], names: {}, ts: "x" }));
kv.writes = 0;
r = await sync(env(kv));
console.log("=== 2. normal tick ===", JSON.stringify(r));
expect(posts.length === 4, "posts all 4 pending events");
expect(r.failures === 0, "no failures");
expect(kv.writes === 1, "one KV write for the batch");

// 3. idempotency AND the write budget
posts = [];
kv.writes = 0;
kv.reads = 0;
r = await sync(env(kv));
console.log("=== 3. idle tick ===", JSON.stringify(r));
expect(posts.length === 0, "re-running posts nothing - no duplicates");
expect(kv.writes === 0, "an idle tick performs ZERO KV writes (the 1,000/day budget)");
expect(kv.reads === 1, "an idle tick performs exactly one KV read");

// 4. partial failure
posts = [];
kv.store.set("sync-state", JSON.stringify({ v: 2, ids: [], names: { 1: "User1", 2: "User2", 3: "User3" }, ts: "x" }));
clickupFails = 1;
r = await sync(env(kv));
console.log("=== 4. partial failure ===", JSON.stringify(r));
expect(posts.length === 3, "the other 3 still post after the first fails");
expect(r.failures === 1, "the failure is reported");
const kept = JSON.parse(kv.store.get("sync-state")).ids;
expect(!kept.includes(101), "the failed event is NOT recorded, so the next tick retries it");

// 5. message format must match what is already in the channel
posts = [];
kv.store.set("sync-state", JSON.stringify({ v: 2, ids: [], names: {}, ts: "x" }));
globalThis.fetch = (((orig) => async (url, opts) => {
  if (String(url).includes("/tracking_states")) {
    return new Response(JSON.stringify({
      tracking_states: [
        { id: 900, occurred_at: "2026-10-05T05:13:01Z", type: "start", user_id: 7 },
        { id: 901, occurred_at: "2026-10-04T22:51:15Z", type: "stop", user_id: 8 },
      ],
    }), { status: 200 });
  }
  return orig(url, opts);
})(globalThis.fetch));
await sync(env(kv));
console.log("=== 5. rendering ===");
for (const p of posts) console.log("  " + p.replace("\n", " / "));
expect(posts.some((p) => p === "\u{1F534} **Clocked Out** — User8\n\u{1F550} 00:51 Stockholm · 06:51 Manila"),
  "clock-out renders byte-identical to the channel");
expect(posts.some((p) => p === "\u{1F7E2} **Clocked In** — User7\n\u{1F550} 07:13 Stockholm · 13:13 Manila"),
  "clock-in renders byte-identical to the channel");

console.log(failed ? "\nTESTS FAILED" : "\nALL TESTS PASSED");
process.exit(failed ? 1 : 0);
