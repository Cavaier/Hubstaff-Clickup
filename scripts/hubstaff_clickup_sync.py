#!/usr/bin/env python3
"""Polls Hubstaff for new timer start/stop events and posts them to a ClickUp chat channel.

Required environment variables:
  HUBSTAFF_PERSONAL_ACCESS_TOKEN  Hubstaff personal access token, used directly as a Bearer token
  CLICKUP_API_TOKEN               ClickUp API token (sent as-is in the Authorization header)
"""
import json
import os
import sys
from datetime import datetime, timedelta, timezone
from urllib.parse import urlencode
import urllib.request
import urllib.error

HUBSTAFF_ORG_ID = 482654
CLICKUP_WORKSPACE_ID = "90161343471"
CLICKUP_CHANNEL_ID = "2kz0huzf-2076"

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


def load_state():
    if os.path.exists(STATE_PATH):
        with open(STATE_PATH) as f:
            return json.load(f)
    now = datetime.now(timezone.utc)
    return {"last_checked_at": (now - timedelta(minutes=10)).strftime("%Y-%m-%dT%H:%M:%SZ"), "user_names": {}}


def save_state(state):
    os.makedirs(os.path.dirname(STATE_PATH), exist_ok=True)
    with open(STATE_PATH, "w") as f:
        json.dump(state, f, indent=2)
        f.write("\n")


def main():
    state = load_state()
    now = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    start = state["last_checked_at"]
    stop = now

    start_dt = datetime.strptime(start, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc)
    stop_dt = datetime.strptime(stop, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc)

    if stop_dt <= start_dt:
        print("Nothing to do (stop <= start)")
        return

    # Hubstaff limits the occurred[start]/occurred[stop] range to 7 days.
    if stop_dt - start_dt > timedelta(days=6, hours=23):
        start_dt = stop_dt - timedelta(days=6)
        start = start_dt.strftime("%Y-%m-%dT%H:%M:%SZ")

    events = []
    page_start_id = None
    while True:
        params = {
            "organization_id": HUBSTAFF_ORG_ID,
            "occurred[start]": start,
            "occurred[stop]": stop,
            "page_limit": 100,
        }
        if page_start_id:
            params["page_start_id"] = page_start_id
        resp = hubstaff_get(f"/organizations/{HUBSTAFF_ORG_ID}/tracking_states", params)
        batch = resp.get("tracking_states", [])
        events.extend(batch)
        if len(batch) < 100:
            break
        page_start_id = batch[-1]["id"]

    events.sort(key=lambda e: e["occurred_at"])

    for event in events:
        if event["type"] not in ("start", "stop"):
            continue
        uid = str(event["user_id"])
        if uid not in state["user_names"]:
            user_resp = hubstaff_get(f"/users/{uid}")
            state["user_names"][uid] = user_resp["user"]["name"]
        name = state["user_names"][uid]
        hhmm = event["occurred_at"][11:16]
        if event["type"] == "start":
            content = f"\U0001F7E2 **{name}** clocked in at {hhmm} UTC _(automated via Hubstaff)_"
        else:
            content = f"\U0001F534 **{name}** clocked out at {hhmm} UTC _(automated via Hubstaff)_"
        clickup_send_message(content)
        print(f"Posted: {content}")

    state["last_checked_at"] = stop
    save_state(state)


if __name__ == "__main__":
    try:
        main()
    except urllib.error.HTTPError as e:
        print(f"ERROR: HTTP {e.code}: {e.read().decode()}", file=sys.stderr)
        sys.exit(1)
    except Exception as e:
        print(f"ERROR: {e}", file=sys.stderr)
        sys.exit(1)
