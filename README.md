# Hubstaff → ClickUp

Posts Hubstaff clock-in / clock-out events into a ClickUp chat channel:

```
🟢 **Clocked In** — Jhonalyn Rivera
🕐 07:13 Stockholm · 13:13 Manila
```

## How it runs

`scripts/hubstaff_clickup_sync.py` (stdlib only, no dependencies) reads Hubstaff's
`tracking_states` API and posts to the ClickUp chat API.

There is no `schedule:` trigger — GitHub's native cron never fired this workflow
reliably. An external **cron-job.org** job calls `workflow_dispatch` through the GitHub
API instead, so the job's cadence is configured there, not in this repo.

## Delivery guarantees

The job is **idempotent, not incremental**. Each run re-reads the last
`LOOKBACK_MINUTES` (6 hours) and skips any event whose Hubstaff id is already in
`posted_event_ids`.

That design is deliberate. The original version advanced a high-water mark to
wall-clock `now` every run and queried `[last_mark, now)`. An event that only became
visible in Hubstaff's API *after* the mark had passed its `occurred_at` was then
unreachable forever — and a lost state file silently rewound the mark to "10 minutes
ago", skipping everything older. On 2026-10-05 that dropped event `490034613`, a
clock-in, leaving the channel showing a member clocked out while Hubstaff had them
working.

Re-reading costs one API call and makes the job self-heal after a late arrival, a
missed cron fire, a lost state file, or two overlapping runs.

| Behaviour | Where |
|---|---|
| Re-reads a 6h window every run, dedupes on event id | `LOOKBACK_MINUTES` (360) |
| Remembers the most recent ids, pruned by value | `MAX_REMEMBERED_IDS` (1000) |
| Hold-back before an event may post | `SETTLE_SECONDS` (0 — off) |
| Drops stop→start bounces by the same member | `PAIR_COLLAPSE_SECONDS` (0 — off) |

## Latency

Events post as soon as a run picks them up. End to end that is roughly **5–10 seconds**
from dispatch — runner start ~3s, checkout and state restore ~2s, the post itself well
under a second — on top of however long it is until the next cron-job.org fire.

At a one-minute cadence the polling interval is therefore the whole story: 0–60s of
waiting, then a few seconds of work. Nothing else in this repo is worth optimising
until that changes; the only way materially below it is Hubstaff webhooks, which would
push events instead of being polled for them.

`SETTLE_SECONDS` and `PAIR_COLLAPSE_SECONDS` are both **off**, which is what keeps that
number low. They exist for noise reduction: a stop immediately followed by the same
member starting again is usually the desktop client recovering from an idle prompt or a
network blip, and both halves could be suppressed. Deciding that means waiting to see
whether a partner event turns up, so it costs latency on *every* notification to tidy up
an occasional pair. Set `PAIR_COLLAPSE_SECONDS` to the bounce width you want swallowed
and `SETTLE_SECONDS` to something comfortably larger (e.g. 60 and 90) to turn it on.
`SETTLE_SECONDS` must be the larger of the two, or a stop posts alone and its partner
follows on a later run — the worst of both worlds.

None of this affects delivery. **Events are never dropped for being too fast or too
slow**; that guarantee comes entirely from the 6h re-read plus the event-id dedupe,
which are independent of both constants. When collapsing is on, a pair is only
collapsed if *neither* half has posted yet — if the stop already went out, the start
always posts, because swallowing it would recreate the exact bug above.

## State

State lives on the orphan **`state` branch**, force-pushed as a single commit each run.
It holds nothing but opaque Hubstaff event ids — no names, no timestamps, no member
ids — so it is safe in a public repo. `.gitignore` keeps it off `main`.

It is deliberately *not* in the Actions cache: entries there are branch-scoped and
evicted after 7 days, and a silent cache miss used to make the job skip events.

**With no state branch, a run seeds one and posts nothing.** That is the cold-start
guard — without it an empty state plus a 6-hour lookback would dump hours of backlog
into the channel at once. It also means the first run after deploying posts nothing,
and events from the preceding 6 hours are marked handled rather than sent.

## Tests

```
python3 tests/test_sync.py
```

Stdlib only, no tokens, no network — the Hubstaff and ClickUp calls are stubbed.
Covers the cold-start guard, dedupe across runs, the orphaned-start case that caused
the original bug, partial-failure handling, pruning, timestamp parsing, and bounce
collapsing in both the on and off configurations.

## Setup

Repository secrets:

| Secret | Purpose |
|---|---|
| `HUBSTAFF_PERSONAL_ACCESS_TOKEN` | Hubstaff PAT, sent as a Bearer token |
| `CLICKUP_API_TOKEN` | ClickUp API token, sent as-is in `Authorization` |

**Settings → Actions → General → Workflow permissions** must be *Read and write
permissions*, or the `state` branch push is rejected and every run cold-starts. A repo
set to read-only overrides the workflow's own `contents: write`.

Targets are hardcoded at the top of the script: Hubstaff org `482654`, ClickUp
workspace `90161343471`, channel `2kz0huzf-2076`.

Run logs print only event and user ids — never names or message bodies — because logs
on a public repo are world-readable.
