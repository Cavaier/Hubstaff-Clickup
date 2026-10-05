"""Logic tests for hubstaff_clickup_sync.

Run with `python3 tests/test_sync.py`. Stdlib only, no tokens and no network: the
Hubstaff and ClickUp calls are stubbed, so this is safe to run anywhere. Exits
non-zero on the first failure.
"""
import importlib.util, json, os, sys, tempfile
from datetime import datetime, timedelta, timezone

SCRIPT = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                      "scripts", "hubstaff_clickup_sync.py")
spec = importlib.util.spec_from_file_location("sync", SCRIPT)
sync = importlib.util.module_from_spec(spec)
spec.loader.exec_module(sync)
sync.STATE_PATH = os.path.join(tempfile.mkdtemp(), "state.json")

NOW = datetime.now(timezone.utc)
def ago(sec): return (NOW - timedelta(seconds=sec)).strftime("%Y-%m-%dT%H:%M:%SZ")

# 102/103 are a 10-second stop->start bounce by one member: the exact shape of the
# event dropped in production. 105 is seconds old, to prove nothing is held back.
EVENTS = [
    {"id": 101, "occurred_at": ago(300), "type": "start", "user_id": 1},
    {"id": 102, "occurred_at": ago(200), "type": "stop",  "user_id": 2},
    {"id": 103, "occurred_at": ago(190), "type": "start", "user_id": 2},
    {"id": 104, "occurred_at": ago(150), "type": "start", "user_id": 3},
    {"id": 105, "occurred_at": ago(5),   "type": "start", "user_id": 4},
]
ALL = {e["id"] for e in EVENTS}

posted = []
sync.fetch_events = lambda a, b: list(EVENTS)
sync.hubstaff_get = lambda path, params=None: {"user": {"name": f"User{path.rsplit('/',1)[1]}"}}
sync.clickup_send_message = lambda c: posted.append(c)

def seed(ids): json.dump({"version": 2, "posted_event_ids": list(ids)}, open(sync.STATE_PATH, "w"))
def state(): return set(json.load(open(sync.STATE_PATH))["posted_event_ids"])
def run():
    posted.clear()
    try: sync.main()
    except SystemExit: pass
    return list(posted)
def expect(cond, msg):
    print(("  PASS " if cond else "  FAIL ") + msg)
    if not cond: sys.exit(1)

print("=== defaults: SETTLE_SECONDS=%s PAIR_COLLAPSE_SECONDS=%s ==="
      % (sync.SETTLE_SECONDS, sync.PAIR_COLLAPSE_SECONDS))
expect(sync.SETTLE_SECONDS == 0 and sync.PAIR_COLLAPSE_SECONDS == 0, "ship with no hold-back")

print("\n=== 1. cold start ===")
if os.path.exists(sync.STATE_PATH): os.remove(sync.STATE_PATH)
expect(run() == [], "posts nothing on a cold start")
expect(state() == ALL, "seeds every id in the window")

print("\n=== 2. normal run, nothing posted yet ===")
seed([])
out = run()
expect(len(out) == 5, "posts all 5 events with no hold-back")
expect(any("User4" in m for m in out), "posts a 5-second-old event immediately")
expect(state() == ALL, "records them all")

print("\n=== 3. immediate re-run (idempotency) ===")
expect(run() == [], "re-running posts nothing - no duplicates")

print("\n=== 4. the production bug: stop posted, start arrives later ===")
seed([102])
out = run()
expect(any("User2" in m and "Clocked In" in m for m in out), "posts the orphaned start")

print("\n=== 5. a failed post does not strand the batch ===")
seed([])
calls = {"n": 0}
def flaky(c):
    calls["n"] += 1
    if calls["n"] == 1: raise RuntimeError("ClickUp 429")
    posted.append(c)
sync.clickup_send_message = flaky
out = run()
expect(len(out) == 4, "the remaining 4 still post after the first fails")
expect(101 not in state(), "the failed event is NOT recorded, so the next run retries it")
sync.clickup_send_message = lambda c: posted.append(c)

print("\n=== 6. bounce collapsing still works when enabled ===")
sync.SETTLE_SECONDS, sync.PAIR_COLLAPSE_SECONDS = 90, 60
seed([])
out = run()
expect(not any("User2" in m for m in out), "suppresses both halves of the 10s bounce")
expect(not any("User4" in m for m in out), "holds back the event inside the settle window")
expect(len(out) == 2, "posts only the two standalone settled events")
seed([102])
out = run()
expect(any("User2" in m and "Clocked In" in m for m in out),
       "never swallows a start whose stop already posted")
sync.SETTLE_SECONDS, sync.PAIR_COLLAPSE_SECONDS = 0, 0

print("\n=== 7. pruning ===")
sync.MAX_REMEMBERED_IDS = 3
sync.save_posted_ids({1,2,3,4,5,6,7})
expect(json.load(open(sync.STATE_PATH))["posted_event_ids"] == [7,6,5], "keeps the highest N ids")

print("\n=== 8. tolerant timestamp parsing ===")
for s in ["2026-10-05T07:02:20Z", "2026-10-05T07:02:20.123Z", "2026-10-05T09:02:20+02:00", "2026-10-05T07:02:20"]:
    print(f"  {s!r} -> {sync.parse_ts(s).isoformat()}")
expect(sync.parse_ts("2026-10-05T07:02:20Z") == sync.parse_ts("2026-10-05T09:02:20+02:00"), "offsets normalise to UTC")

print("\nALL TESTS PASSED")
