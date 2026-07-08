# devin-stream — design & evidence

Capture rich, live data from logged-in **app.devin.ai** tabs in Chrome and stream
it to a centralized local service so automations can be built on top (e.g. a
per-AeroSpace-workspace overview of every Devin session and its proposed next
action).

Two pieces:

- **Extension** — `chrome-extensions/devin-stream/` (unpacked MV3, app.devin.ai only)
- **Sink** — `home-manager/scripts/devin-stream-sink` (Python stdlib HTTP server on `127.0.0.1:48292`)

---

## 1. On-disk evidence (empirical, no browser needed)

Inspected `~/Library/Application Support/Google/Chrome/Default/` while the Devin
tabs were open and active (local time ~11:1x PDT on 2026-07-08). Values were
sampled with strict size limits (`strings | head`, token frequency counts).

### IndexedDB — `IndexedDB/https_app.devin.ai_0.indexeddb.leveldb/` — **LIVE**

```
001114.log   187 KB   mtime 10:42   <- fresh, written this session
001116.ldb    24 KB   mtime Jul 7 13:01
MANIFEST-000001, CURRENT, LOCK, LOG
```

Fresh `.log` mtime (minutes old) with the tabs open confirms IndexedDB is being
**continuously updated**. Database / object-store / key names recovered via
`strings` + token frequency:

- **Database `devin-review`** (dominant, ~all fresh writes). Records keyed
  `bug-BUG_pr-review-job-<hash>_NNNN`. Value fields seen as serialized keys:
  `prId`, `commitSha`, `updatedAt`, `fingerprint`, `schema`, `data`, `value`.
  File-path payloads reference the reviewed repo
  (`rust/scripts/main-bus/control/src/...`). This is Devin's **PR-review** cache.
- Object stores / keys observed: `store`, `pr-queue-page`, `queue-workspace`,
  `queue-events`, `chat`, and index keys **`sessionIdsA` (sessionIds)**,
  **`activeSessionId`**, `createdAt`, `updatedAt`.
- Per-PR databases `pr-review-job-<hash>` also present.

**Critical caveat:** IndexedDB values are stored on disk in V8 **structured-clone**
format, not JSON — `strings` reveals *field names and string values* but never a
clean decoded record. Full decode requires reading through the live
`indexedDB` API **from inside the tab**. This is the core reason the extension
ships a discovery/inventory mode (below): schema iteration must continue from the
live DB, not from `strings` on disk.

### localStorage — `Local Storage/leveldb/` — **LIVE, readable JSON**

The `.log` rotates every few seconds (compaction), itself a freshness signal.
The high-churn writer is `feature-flags-cache:org_<id>` (full flag list, rewritten
with a new `expiresAt` on a timer). Notable flags present:
`ws-auth-middleware`, `incremental-message-history`, `automations-ingestion`,
`linear-automation-triggers`, `devin-omni-box-page`, `session-repos-metadata`.

Session-facing keys (JSON values, directly readable):

```
chat-msg-map                      session-tabs:<...>
pending-optimistic-messages       input-box-store
pr-review-in-session-active-tab   member-info-v1-org_<id>-email|<uid>
post-auth-v3-...                  sidebar-collapsed-folders:org_<id>
comment-viewed-times              workspace-panel-expanded
pr-viewed-exa-labs/monorepo/<n>   @@auth0spajs@@::<...>   (auth token)
```

### Session Storage / Service Worker

- `Session Storage/` present, small, UI-scoped; fresh mtime.
- `Service Worker/CacheStorage/` has many caches but they hold static assets;
  no decodable Devin **API response** cache. (The only API-shaped script cache
  hits belonged to 1Password, not Devin.)

### What is *not* on disk

The live conversation stream — streaming agent messages, current status, and
"proposing next actions" — is **not** persisted in decodable form. Combined with
the `ws-auth-middleware` + `incremental-message-history` flags, this means the
rich live data is delivered over the **network (WebSocket / fetch / SSE)** and held
in **MAIN-world JS memory** (the SPA's query/store cache). IndexedDB persists the
PR-review cache and a session index, not the message feed.

---

## 2. Channel ranking (by what the evidence supports)

| Rank | Channel | Evidence | Richness / liveness | Cost |
|------|---------|----------|--------------------|------|
| **1** | **MAIN-world network interception** (wrap `fetch` / `XHR` / `WebSocket` / `EventSource`) | `ws-auth-middleware`, `incremental-message-history` flags; no message feed on disk ⇒ it's on the wire | Highest — exactly what the UI receives, in real time (messages, status, next-action proposals) | Needs a `world:"MAIN"` script; payloads must be truncated |
| **2** | **MAIN-world JS state** (query/Zustand/Redux cache) | SPA renders from an in-memory normalized store | Very high, already-parsed | Brittle: depends on internal handles/minified shapes |
| **3** | **IndexedDB polling from the live tab** (decoded via `indexedDB` API) | `devin-review` fresh at 10:42; `sessionIds`, `activeSessionId`, `chat`, `queue-*` stores | High for durable PR-review + session index; **not** the live message feed | Values are structured-clone → must read via API, not disk |
| **4** | **localStorage polling** | Readable JSON: `session-tabs`, `chat-msg-map`, `pending-optimistic-messages`, feature flags, org/auth | Good for cheap session enumeration + change detection | Churns (also *useful* as a change signal) |
| **5** | **BroadcastChannel sniffing** | No on-disk evidence Devin uses it | Unknown | Opportunistic only |

**Primary mode = #1 (network interception)** for the live feed, **plus #3/#4
discovery** to enumerate and decode the durable stores so schema work continues
outside the browser. #2 is a future enhancement once specific store handles are
identified from the captured traffic.

---

## 3. Architecture

```
 app.devin.ai tab
 ┌───────────────────────────────────────────────┐
 │ inject.js  (world: MAIN, run_at document_start)│
 │   wraps fetch / XHR / WebSocket / EventSource  │
 │   → window.postMessage({__devinStream:...})    │
 ├───────────────────────────────────────────────┤
 │ content.js (world: ISOLATED)                   │
 │   • relays MAIN net captures (batched ~1.5s)   │
 │   • discovery: indexedDB.databases() → stores  │
 │     → counts + truncated record samples;       │
 │     localStorage/sessionStorage key dump       │
 │   • session context: id (URL), title, awaiting │
 │   → chrome.runtime.sendMessage                 │
 └───────────────────────────────────────────────┘
                     │  chrome.runtime messages
                     ▼
 ┌───────────────────────────────────────────────┐
 │ background.js (service worker)                 │
 │   • POST envelopes → sink /ingest (batched)    │
 │   • re-inject both worlds into open tabs on    │
 │     worker start / install                     │
 │   • dev auto-reload (fingerprint own files →   │
 │     chrome.runtime.reload(), 3-min cooldown)   │
 └───────────────────────────────────────────────┘
                     │  HTTP POST 127.0.0.1:48292/ingest
                     ▼
 ┌───────────────────────────────────────────────┐
 │ devin-stream-sink (Python, launchd KeepAlive)  │
 │   events.jsonl · sessions/<id>.jsonl · latest  │
 └───────────────────────────────────────────────┘
```

Why the split worlds: content scripts run in an ISOLATED JS world and cannot see
the page's real `fetch`/`WebSocket`, so network interception must run in `MAIN`.
But `indexedDB`/`localStorage` are origin-partitioned and fully readable from the
ISOLATED content script, so discovery lives there (simpler, no page-global
pollution). The two communicate via `window.postMessage` scoped to the origin.

### Envelope

Every event POSTed to the sink:

```json
{
  "source": "devin-stream",
  "kind": "net" | "discovery" | "session" | "event",
  "sessionId": "<uuid from /sessions/<id>>" | null,
  "url": "https://app.devin.ai/sessions/...",
  "tabId": 123,
  "bootId": "worker-boot-id",
  "data": { ...channel-specific... }
}
```

- `net` — `{channel:"fetch|xhr|ws|sse", url, method?, status?, body(≤24 KB, truncated)}`
- `discovery` — `{indexedDB:[{name,version,stores:[{store,count,keyPath,samples:[{key,value≤1.5 KB}]}]}], localStorage:{keys,samples}, sessionStorageKeys, title, awaiting}`
- `session` — `{title, awaiting, status}`
- `event` — worker diagnostics (`worker-start`, `installed`, `reloading`)

Truncation limits (in code): net body 24 KB, WS/SSE frame 24 KB, IDB record
sample 1.5 KB × 3 per store, localStorage 120 keys × 800 B. Keeps volume sane and
avoids the multi-MB CPU-pegging problem noted in the window-colors debug survey.

---

## 4. Storage schema (sink) — `~/.local/state/devin-stream/`

```
events.jsonl              append-only log of every envelope (rotate at 50 MB)
sessions/<sessionId>.jsonl per-session event log (rotate at 10 MB each)
latest.json               aggregated snapshot (mirrored to memory on start)
```

`latest.json` / `GET /state` shape:

```json
{
  "sessions": {
    "<sessionId>": {
      "sessionId": "...", "events": N, "lastSeen": "<ts>",
      "url": "...", "tabId": 123,
      "title": "...", "status": "awaiting|active", "awaiting": true,
      "latest": { "net": {...}, "session": {...}, "discovery": {...} }
    }
  },
  "discovery": { ...most recent inventory envelope... },
  "updatedAt": "<ts>"
}
```

The sink accepts either a single envelope or `{"events":[...]}` batch. Session ids
are sanitized (`[^A-Za-z0-9_.-]→_`, ≤128 chars) so a malformed id can't escape
`sessions/`.

---

## 5. Automation-watcher concept

A watcher (cron/launchd/loop) joins live Devin session state with the AeroSpace
window layout to produce a per-workspace overview:

1. **Session state** — `GET 127.0.0.1:48292/state` → `sessions{}` map: title,
   status (`awaiting`/`active`), last activity, and (once the network schema is
   mapped) the latest agent message / proposed next action from `latest.net`.
2. **Window→workspace mapping** — `aerospace list-windows --all` gives
   `wid | app | title`; `~/.cache/aerospace-layout.json` gives each window's
   workspace (`ws`), monitor, coords, and a screenshot path. Chrome Devin tabs
   show up as `... - Google Chrome - Adriano (exa.ai)` with the session title in
   the window title, so titles can be matched to `sessions{}.title` (and the
   window-colors extension already keys the same session ids for color/symbol).
3. **Join** — group sessions by AeroSpace workspace via the matched window's `ws`,
   surfacing per workspace: which sessions are **awaiting instructions**, which
   are active, and each one's proposed next action. Feed that to SketchyBar, a
   notification, or a dashboard.

`net` bodies are the eventual source of "next action" text; until those endpoints
are labelled from captured traffic, `session.awaiting` + `title` already give a
useful per-workspace "needs attention" view.

---

## 6. Handoff steps

### a. Load the extension

1. Chrome → `chrome://extensions`
2. Toggle **Developer mode** (top-right).
3. **Load unpacked** → select
   `/Users/joaoadriano/projs/configs/chrome-extensions/devin-stream/`.
4. Open (or reload) an `app.devin.ai` session tab. On worker start the background
   also re-injects into already-open Devin tabs, so a manual reload isn't strictly
   required.

Dev loop is hands-free after that: edit any file in `devin-stream/`, and within
~30 s the background fingerprint poll calls `chrome.runtime.reload()` (3-min
cooldown guards against reload loops). Watch progress via the sink.

### b. Start the sink (dev)

```bash
python3 ~/projs/configs/home-manager/scripts/devin-stream-sink
# then, from another shell:
curl -s 127.0.0.1:48292/state | jq .
tail -f ~/.local/state/devin-stream/events.jsonl
ls ~/.local/state/devin-stream/sessions/
```

### c. Persist the sink via launchd (add to `home.nix` — NOT edited here)

Add this alongside the existing `launchd.agents.window-colors-sink` block:

```nix
  # Local sink for the devin-stream Chrome extension: receives live session
  # captures (network stream + IndexedDB/localStorage discovery) so they can be
  # inspected and automated on outside the browser (~/.local/state/devin-stream/).
  launchd.agents.devin-stream-sink = {
    enable = true;
    config = {
      Label = "local.devin-stream-sink";
      ProgramArguments = [
        "/usr/bin/python3"
        "${config.home.homeDirectory}/projs/configs/home-manager/scripts/devin-stream-sink"
      ];
      RunAtLoad = true;
      KeepAlive = true;
      StandardOutPath = "/tmp/devin-stream-sink.out.log";
      StandardErrorPath = "/tmp/devin-stream-sink.err.log";
    };
  };
```

Then apply the home-manager generation (however this repo normally applies it,
e.g. `home-manager switch`). Verify: `curl -s 127.0.0.1:48292/state`.

### d. Iterate on IndexedDB schema from outside the browser

Once loaded, the discovery envelope in `GET /state` → `discovery.data.indexedDB`
lists every database, object store, record count, and truncated samples from the
**live** tab (decoded, unlike `strings` on disk). Use it to identify which store /
record shape carries the session message feed, then extend `content.js`
(`inventoryIndexedDB`) or the `net` classification to promote that channel.

---

## 7. Verification performed

- `node --check` on `background.js`, `content.js`, `inject.js` — all pass.
- `manifest.json` parses as JSON.
- `python3 -m py_compile devin-stream-sink` — passes.
- Ran the sink in foreground; `POST /ingest` (single + batch) returned
  `{"ok":true,"ingested":N}`; `GET /state` returned the aggregated snapshot;
  `events.jsonl`, `latest.json`, and `sessions/<id>.jsonl` were written as
  designed. Process then killed; test state removed.

Not verifiable here (requires a logged-in browser): actual network/IndexedDB
capture from a live Devin tab. The discovery mode exists precisely so that step
is self-documenting once the user loads the extension.
