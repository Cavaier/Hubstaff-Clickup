#!/usr/bin/env python3
"""Polls Hubstaff for timer start/stop events and posts them to a ClickUp chat channel.

Why this job is idempotent rather than incremental
--------------------------------------------------
Every run re-queries a wide rolling window and skips any event whose Hubstaff id is
already recorded in `posted_event_ids`.

The earlier design advanced a high-water mark to wall-clock `now` on every run and
queried `[last_mark, now)`. Any event that became visible in Hubstaff's API *after*
the mark had already moved past its `occurred_at` was then invisible forever, with
nothing in the logs to show for it. That silently dropped a real clock-in on
2026-10-05 (event 490034613), leaving the channel showing a member clocked out while
Hubstaff had them working.

Re-reading the same events costs one cheap API call, and it makes the job heal itself
after a late arrival, a missed cron fire, a lost state file, or two overlapping runs.

Required environment variables:
  HUBSTAFF_PERSONAL_ACCESS_TOKEN  Hubstaff personal access token, used as a Bearer token
  CLICKUP_API_TOKEN               ClickUp API token (sent as-is in the Authorization header)
"""
import json
import os
import sys
from datetime import datetime, timedelta, timezone
from urllib.parse import urlencode
from zoneinfo import ZoneInfo
import urllib.request
import urllib.error

HUBSTAFF_ORG_ID = 482654
CLICKUP_WORKSPACE_ID = "90161343471"
CLICKUP_CHANNEL_ID = "2kz0huzf-2076"

STOCKHOLM_TZ = ZoneInfo("Europe/Stockholm")
MANILA_TZ = ZoneInfo("Asia/Manila")

# How far back each run re-reads. Anything inside this window survives a cron outage,
# a late-arriving event or a lost run; anything older than it is gone for good. Six
# hours of events for a handful of members is a single page, so this is nearly free.
LOOKBACK_MINUTES = 360

# Events newer than this are fetched but not posted yet, so that a stop still has time
# to be joined by its partner start before we decide whether to collapse the pair.
# Must stay larger than PAIR_COLLAPSE_SECONDS or a stop would post alone and the start
# would follow on a later run. This is the notification delay; lower it for a snappier
# feed at the cost of occasionally posting both halves of a bounce.
SETTLE_SECONDS = 90

# A stop immediately followed by the same member starting again is the desktop client
# recovering from an idle prompt or a network blip, not somebody leaving. Posting both
# halves is pure noise, so a pair this close together is suppressed entirely.
PAIR_COLLAPSE_SECONDS = 60

# Cap on remembered ids. Hubstaff ids increase over time, so keeping the highest N is
# the same as keeping the most recent N. Needs to comfortably exceed the number of
# events LOOKBACK_MINUTES can hold.
MAX_REMEMBERED_IDS = 1000

PAGE_LIMIT = 100

# Hubstaff's API sits behind Cloudflare and blocks requests without a browser-like User-Agent.
USER_AGENT = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"

STATE_PATH = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "state", "hubstaff_clickup_state.json")


def http_json(method, url, headers=None, body=None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method=method)
    req.add_header("User-Agent", USER_AGENT)
    req.add_header("Accept", "application/json")
    for k, v in (headers or {}).items():
        req.add_header(k, v)
    if data is not None:
        req.add_header("Content-Type", "application/json")
    with urllib.request.urlopen(req, timeout=30) as resp:
        return json.loads(resp.read().decode())


def hubstaff_get(path, params=None):
    token = os.environ["HUBSTAFF_PERSONAL_ACCESS_TOKEN"]
    url = f"https://api.hubstaff.com/v2{path}"
    if params:
        url += "?" + urlencode(params, doseq=True)
    return http_json("GET", url, headers={"Authorization": f"Bearer {token}"})


def clickup_send_message(content):
    token = os.environ["CLICKUP_API_TOKEN"]
    url = f"https://api.clickup.com/api/v3/workspaces/{CLICKUP_WORKSPACE_ID}/chat/channels/{CLICKUP_CHANNEL_ID}/messages"
    return http_json(
        "POST",
        url,
        headers={"Authorization": token},
        body={"content": content, "content_format": "text/md", "type": "message"},
    )


def iso(dt):
    return dt.strftime("%Y-%m-%dT%H:%M:%SZ")


def parse_ts(value):
    """Tolerant ISO 8601 parse. A fixed '%Y-%m-%dT%H:%M:%SZ' strptime throws on
    fractional seconds or a +00:00 offset, which would stall the job indefinitely."""
    text = value.strip()
    if text.endswith(("Z", "z")):
        text = text[:-1] + "+00:00"
    dt = datetime.fromisoformat(text)
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc)


def load_posted_ids():
    """Returns the set of already-posted event ids, or None for a cold start.

    None means 'seed, do not post': without it, an empty state plus a six-hour
    lookback would dump hours of backlog into the channel at once.
    """
    if not os.path.exists(STATE_PATH):
        print("NOTICE: no state file - seeding from the current window, posting nothing")
        return None
    try:
        with open(STATE_PATH) as f:
            state = json.load(f)
        return {int(i) for i in state["posted_event_ids"]}
    except (ValueError, KeyError, TypeError) as e:
        print(f"WARNING: state file unreadable ({e}) - reseeding, posting nothing")
        return None


def save_posted_ids(ids):
    pruned = sorted(ids, reverse=True)[:MAX_REMEMBERED_IDS]
    os.makedirs(os.path.dirname(STATE_PATH), exist_ok=True)
    with open(STATE_PATH, "w") as f:
        json.dump({"version": 2, "posted_event_ids": pruned}, f, indent=2)
        f.write("\n")


def fetch_events(start_dt, stop_dt):
    events = []
    cursors_seen = set()
    page_start_id = None
    while True:
        params = {
            "organization_id": HUBSTAFF_ORG_ID,
            "occurred[start]": iso(start_dt),
            "occurred[stop]": iso(stop_dt),
            "page_limit": PAGE_LIMIT,
        }
        if page_start_id is not None:
            params["page_start_id"] = page_start_id
        resp = hubstaff_get(f"/organizations/{HUBSTAFF_ORG_ID}/tracking_states", params)
        batch = resp.get("tracking_states", [])
        events.extend(batch)

        # Follow the documented cursor. The old code paged on `batch[-1]["id"]` and
        # stopped at `len(batch) < 100`, which both assumes the response is id-ordered
        # and re-reads the boundary row.
        next_id = (resp.get("pagination") or {}).get("next_page_start_id")
        if not next_id and len(batch) == PAGE_LIMIT:
            # No documented cursor but a full page: fall back to the highest id seen.
            # Deliberately not id+1 - whether page_start_id is inclusive is undocumented,
            # and re-reading one row is harmless next to skipping one.
            next_id = max(e["id"] for e in batch)
        if not next_id or next_id in cursors_seen:
            break
        cursors_seen.add(next_id)
        page_start_id = next_id
    return events


def find_bounce_pairs(events, already_posted):
    """Ids of stop/start pairs close enough together to be a client bounce.

    A pair is only collapsed when neither half has been posted yet. If the stop
    already went out on an earlier run, swallowing the start would recreate the very
    bug this script exists to fix: a member shown clocked out while actually working.
    """
    suppressed = set()
    by_user = {}
    for event in events:
        by_user.setdefault(event["user_id"], []).append(event)

    for sequence in by_user.values():
        i = 0
        while i < len(sequence) - 1:
            stop_event, start_event = sequence[i], sequence[i + 1]
            if stop_event["type"] == "stop" and start_event["type"] == "start":
                gap = (parse_ts(start_event["occurred_at"]) - parse_ts(stop_event["occurred_at"])).total_seconds()
                unposted = stop_event["id"] not in already_posted and start_event["id"] not in already_posted
                if 0 <= gap <= PAIR_COLLAPSE_SECONDS and unposted:
                    suppressed.add(stop_event["id"])
                    suppressed.add(start_event["id"])
                    i += 2
                    continue
            i += 1
    return suppressed


def describe(event, name):
    occurred = parse_ts(event["occurred_at"])
    label = "Clocked In" if event["type"] == "start" else "Clocked Out"
    emoji = "\U0001F7E2" if event["type"] == "start" else "\U0001F534"
    return (
        f"{emoji} **{label}** — {name}\n"
        f"\U0001F550 {occurred.astimezone(STOCKHOLM_TZ):%H:%M} Stockholm"
        f" · {occurred.astimezone(MANILA_TZ):%H:%M} Manila"
    )


def main():
    posted = load_posted_ids()
    seeding = posted is None
    if seeding:
        posted = set()

    now = datetime.now(timezone.utc)
    events = [
        e for e in fetch_events(now - timedelta(minutes=LOOKBACK_MINUTES), now)
        if e.get("type") in ("start", "stop")
    ]
    events.sort(key=lambda e: (parse_ts(e["occurred_at"]), e["id"]))
    print(f"fetched {len(events)} start/stop events over the last {LOOKBACK_MINUTES}m")

    if seeding:
        save_posted_ids({e["id"] for e in events})
        print(f"seeded {len(events)} ids; posting skipped on this run")
        return

    suppressed = find_bounce_pairs(events, posted)
    cutoff = now - timedelta(seconds=SETTLE_SECONDS)

    names = {}
    failures = 0
    for event in events:
        if event["id"] in posted:
            continue
        if event["id"] in suppressed:
            # Recorded as handled so it is never reconsidered once it ages past the pair window.
            posted.add(event["id"])
            print(f"suppressed bounce event {event['id']} (user_id={event['user_id']})")
            continue
        if parse_ts(event["occurred_at"]) > cutoff:
            continue

        uid = str(event["user_id"])
        try:
            if uid not in names:
                names[uid] = hubstaff_get(f"/users/{uid}")["user"]["name"]
            clickup_send_message(describe(event, names[uid]))
        except Exception as e:
            # One bad post must not strand the rest of the batch. The event stays out
            # of `posted`, so the next run retries it.
            failures += 1
            print(f"ERROR: failed to post event {event['id']} (user_id={uid}): {e}", file=sys.stderr)
            continue

        posted.add(event["id"])
        # Deliberately not logging names or message bodies - run logs are public.
        print(f"posted {event['type']} event {event['id']} (user_id={uid})")

    save_posted_ids(posted)
    if failures:
        sys.exit(1)


if __name__ == "__main__":
    try:
        main()
    except urllib.error.HTTPError as e:
        print(f"ERROR: HTTP {e.code}: {e.read().decode()}", file=sys.stderr)
        sys.exit(1)
    except Exception as e:
        print(f"ERROR: {e}", file=sys.stderr)
        sys.exit(1)
