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
| Re-reads a 6h window every run, dedupes on event id | `LOOKBACK_MINUTES` |
| Holds events back briefly so bounce pairs resolve | `SETTLE_SECONDS` (90s) |
| Drops stop→start bounces by the same member | `PAIR_COLLAPSE_SECONDS` (60s) |
| Remembers the most recent ids, pruned by value | `MAX_REMEMBERED_IDS` (1000) |

`SETTLE_SECONDS` must stay larger than `PAIR_COLLAPSE_SECONDS`, or a stop posts alone
and its partner start follows on a later run. It is also the notification delay —
lower both for a snappier feed, at the cost of occasionally posting both halves of a
client bounce.

A bounce pair is only collapsed when **neither** half has been posted yet. If the stop
already went out, the start is always posted — swallowing it would recreate the exact
bug above.

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
