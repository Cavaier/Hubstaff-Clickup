# Worker: Hubstaff → ClickUp

The poll, running on Cloudflare instead of GitHub Actions.

## Why it moved

On GitHub Actions every poll cost a whole workflow run — queue, runner provisioning,
checkout — for well under a second of real work. At one dispatch a minute that has no
headroom: when GitHub's provisioning slowed on 2026-10-05, arrivals outpaced drains and
the backlog grew without bound. Here a tick is a cron trigger with nothing in front of
it, so the work is the only cost.

What carried over unchanged is the property that matters: **idempotent, not
incremental**. Every tick re-reads a 6-hour window and skips any event id it has already
posted. Late arrivals, missed ticks and restarts all heal on the next pass.

## Free-plan budget

This is shaped around the free limits, not merely fitting inside them:

| | Limit | Used |
|---|---|---|
| Requests | 100,000/day | 1,440 (one per minute) |
| KV reads | 100,000/day | 1,440 (one per tick) |
| **KV writes** | **1,000/day** | **tens** — only when something changed |
| CPU | 10ms/request | two JSON parses; the fetches are I/O |

KV writes are the binding constraint. A tick that finds nothing new writes **nothing** —
an unconditional write would be 1,440/day and blow the budget by 40%. There's a test
asserting an idle tick performs zero writes; keep it.

## Deploy

From this directory:

```bash
npx wrangler login
npx wrangler kv namespace create SYNC_STATE   # paste the printed id into wrangler.toml
npx wrangler secret put HUBSTAFF_PERSONAL_ACCESS_TOKEN
npx wrangler secret put CLICKUP_API_TOKEN
npx wrangler secret put TRIGGER_TOKEN          # optional, enables POST /run
npx wrangler deploy
```

Check it: `curl https://hubstaff-clickup-sync.<your-subdomain>.workers.dev/health`

```json
{"ok":true,"seeded":false,"last_state_write":null,"remembered_ids":0}
```

Force a tick without waiting for cron (needs `TRIGGER_TOKEN`):

```bash
curl -X POST "https://hubstaff-clickup-sync.<sub>.workers.dev/run?token=$TRIGGER_TOKEN"
```

## Cutting over from GitHub Actions

**Only one of the two may run at a time.** They keep separate state — the Worker in KV,
the Actions job on the `state` branch — so both running means every event posts twice.

With no state in KV the Worker seeds and posts nothing, which would swallow anything
that happened during the handover. Seeding KV from the `state` branch instead gives a
clean cutover with no gap and no duplicates:

1. **Pause the cron-job.org job.** The Actions poll stops; the `state` branch stops moving.
2. **Seed KV from that final state:**
   ```bash
   git fetch origin state
   git show origin/state:hubstaff_clickup_state.json \
     | python3 -c "import json,sys;d=json.load(sys.stdin);print(json.dumps({'v':2,'ids':d['posted_event_ids'],'names':{},'ts':'seeded-from-github'}))" \
     > seed.json
   npx wrangler kv key put sync-state --path seed.json --binding SYNC_STATE --remote
   ```
   (On wrangler 3 the subcommand is `kv:key put`.)
3. **Deploy.** The first tick sees existing state, so it posts anything that happened
   during the handover rather than swallowing it.
4. **Confirm** the next real clock event lands in the channel.

Leave the Actions workflow in the repo but dormant — re-pointing cron-job.org at it is
the rollback. Just never run both at once.

## Tests

```bash
node test/test_worker.mjs
```

No network, no Cloudflare, no tokens. Covers the seed guard, dedupe across ticks, the
zero-write idle tick, partial-failure handling, and that messages render byte-identical
to what is already in the channel.

## Later: the webhook

Hubstaff pushes `timer.start` / `timer.stop`, which would cut delivery to ~1s. The
`fetch` handler here is where that endpoint goes. It needs Hubstaff's `X-Hook-Secret`
handshake and HMAC verification implemented exactly, and the cron stays as the safety
net — a webhook alone has no recovery path, and a dropped delivery would be gone for
good.
