// Service worker: relays captures from content scripts to the local sink,
// re-injects into already-open Devin tabs on (re)load, and dev auto-reloads
// itself when its own files change on disk.

var SINK_URL = "http://127.0.0.1:48292/ingest";
var BOOT_ID = Date.now().toString(36);

// ── Forward events to the sink ──────────────────────────────────────────────

function shipOne(kind, msg) {
  var envelope = {
    source: "devin-stream",
    kind: kind,
    sessionId: msg.sessionId || null,
    url: msg.url || null,
    tabId: (msg.__tabId != null) ? msg.__tabId : null,
    bootId: BOOT_ID,
    data: msg.data,
  };
  return shipBatch([envelope]);
}

function shipBatch(events) {
  return fetch(SINK_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ events: events }),
  }).catch(function () { /* sink not running; drop */ });
}

chrome.runtime.onMessage.addListener(function (msg, sender) {
  if (!msg) return;
  var tabId = sender && sender.tab ? sender.tab.id : null;
  if (msg.type === "devin-stream") {
    shipOne(msg.kind, { sessionId: msg.sessionId, url: msg.url, data: msg.data, __tabId: tabId });
  } else if (msg.type === "devin-stream-batch" && Array.isArray(msg.events)) {
    var events = msg.events.map(function (e) {
      e.tabId = tabId;
      e.bootId = BOOT_ID;
      return e;
    });
    shipBatch(events);
  }
});

function sinkEvent(payload) {
  shipBatch([Object.assign({ source: "devin-stream", kind: "event", bootId: BOOT_ID }, payload)]);
}

// ── Inject into already-open Devin tabs ─────────────────────────────────────
// Declared content_scripts only run on fresh navigations, so on worker start /
// install push both worlds into every open app.devin.ai tab.

async function injectIntoOpenTabs() {
  var injected = 0;
  try {
    var tabs = await chrome.tabs.query({ url: "https://app.devin.ai/*" });
    for (var i = 0; i < tabs.length; i++) {
      var tab = tabs[i];
      if (!tab.id) continue;
      try {
        await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["inject.js"], world: "MAIN" });
        await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["content.js"], world: "ISOLATED" });
        injected++;
      } catch (e) { /* discarded/unloadable tab */ }
    }
  } catch (e) {}
  return injected;
}

// ── Dev auto-reload ─────────────────────────────────────────────────────────
// Unpacked extensions serve files straight from disk, so fetching our own files
// reflects current disk contents. Poll a fingerprint and reload on change.
// (Copied pattern from chrome-extensions/window-colors/background.js.)

var WATCH_FILES = ["manifest.json", "background.js", "content.js", "inject.js"];
var RELOAD_COOLDOWN_MS = 3 * 60 * 1000;

async function fileFingerprint() {
  var parts = [];
  for (var i = 0; i < WATCH_FILES.length; i++) {
    try {
      var t = await (await fetch(chrome.runtime.getURL(WATCH_FILES[i]))).text();
      if (!t) return null; // worker still initializing; skip this cycle
      parts.push(t);
    } catch (e) {
      return null;
    }
  }
  var s = parts.join("\u0000");
  var h = 0;
  for (var k = 0; k < s.length; k++) h = (h * 31 + s.charCodeAt(k)) | 0;
  return String(h);
}

chrome.alarms.create("watch-files", { periodInMinutes: 0.5 });

chrome.alarms.onAlarm.addListener(async function (alarm) {
  if (alarm.name !== "watch-files") return;
  var fp = await fileFingerprint();
  if (fp === null) return;
  var store = await chrome.storage.local.get(["fileFp", "lastReloadAt"]);
  if (store.fileFp === undefined) {
    await chrome.storage.local.set({ fileFp: fp });
  } else if (store.fileFp !== fp) {
    if (store.lastReloadAt && Date.now() - store.lastReloadAt < RELOAD_COOLDOWN_MS) {
      sinkEvent({ event: "reload-suppressed", bootId: BOOT_ID });
      return;
    }
    await chrome.storage.local.set({ fileFp: fp, lastReloadAt: Date.now() });
    sinkEvent({ event: "reloading", bootId: BOOT_ID });
    chrome.runtime.reload();
  }
});

// ── Active v2sessions refresh ────────────────────────────────────────────────
// Background Devin tabs mostly stop polling v2sessions, so the sink's per-
// session status goes stale and window-colors falls back to its text backstop.
// Fix: every 2.5 min, one designated tab actively refetches the org-wide
// v2sessions list. That single request describes many sessions at once, so the
// sink re-observes every session named in the (truncated) body. The fetch runs
// in the page's MAIN world where inject.js has wrapped window.fetch, so it is
// (a) authenticated with the page's own cookies and (b) captured automatically
// like any app request. Failure-safe: a 401/error just gets logged; the passive
// capture + window-colors text backstop still cover us.
//
// Org/creator ids below are this user's, discovered from captured v2sessions
// URLs (~/.local/state/devin-stream/events.jsonl); they're only a FALLBACK --
// activePollFn prefers window.__dsLastV2SessionsUrl, the exact URL the app
// itself last used (recorded by inject.js), so params stay current over time.
var V2_ORG = "org_CtAKPG8BcFDDfhXn";
var V2_CREATOR = "email%7C6754db1af8d55643c884a3f3";

function fallbackV2Url() {
  var from = new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString();
  return "https://app.devin.ai/api/" + V2_ORG + "/v2sessions" +
    "?include_pinned=true&group_children=true&limit=30" +
    "&order_by=updated_at&sort_direction=desc&creators=" + V2_CREATOR +
    "&updated_date_from=" + encodeURIComponent(from) +
    "&is_archived=false&hide_code_scans=true" +
    "&session_type=devin&session_type=ada";
}

// Candidate tabs to run the poll in, best first: the tab the user is actually
// looking at (active in the focused window), then all app.devin.ai tabs by
// most-recently-accessed. Deduped. The poller walks this list and stops at the
// first tab whose replayed request actually succeeds -- so a single tab that
// has recorded an authenticated v2sessions request (i.e. is running the header-
// recording inject.js) is enough, whichever tab it is.
// The last tab that served an authenticated poll. Tried first next time so the
// steady state is a single executeScript+fetch (not a scan). Lost on worker
// restart, which just triggers one re-scan.
var lastGoodPollTabId = null;

async function candidatePollTabs() {
  var list = [];
  if (lastGoodPollTabId != null) {
    try {
      var g = await chrome.tabs.get(lastGoodPollTabId);
      if (g && /^https:\/\/app\.devin\.ai\//.test(g.url || "")) list.push(g);
    } catch (e) { lastGoodPollTabId = null; }
  }
  try {
    var act = await chrome.tabs.query({
      url: "https://app.devin.ai/*", active: true, lastFocusedWindow: true,
    });
    if (act) list = list.concat(act);
  } catch (e) {}
  try {
    var all = await chrome.tabs.query({ url: "https://app.devin.ai/*" });
    all.sort(function (a, b) { return (b.lastAccessed || 0) - (a.lastAccessed || 0); });
    list = list.concat(all);
  } catch (e) {}
  var seen = {}, out = [];
  for (var i = 0; i < list.length; i++) {
    var t = list[i];
    if (t && t.id != null && !seen[t.id]) { seen[t.id] = 1; out.push(t); }
  }
  return out;
}

// Injected verbatim into the page's MAIN world (serialized -- no closure over
// worker scope; the fallback URL comes in via args). window.fetch is the
// inject.js-wrapped fetch, so this request is captured automatically.
// Auth: v2sessions 401s on a bare credentials-only fetch (the SPA attaches an
// Authorization header from its in-memory token), so we replay the exact
// request inject.js recorded from the app's own v2sessions call -- URL AND
// headers. The bare fallback (no recorded request yet in this tab) will 401
// until the tab has issued/observed a v2sessions request under the new
// inject.js; that's failure-safe by design.
function activePollFn(fallbackUrl, sessionIds) {
  var rec = window.__dsLastV2SessionsReq;
  var headers = (rec && rec.headers) || {};
  var base = (rec && rec.url) || window.__dsLastV2SessionsUrl || fallbackUrl;
  // Reuse the app's auth headers (the token isn't URL-specific), and build the
  // query for maximum coverage of the sessions we actually care about. When the
  // caller supplies the OPEN TABS' session ids, request exactly those via a
  // session_ids batch -- that guarantees every open tab's session is re-folded,
  // even idle ones far down the updated_at order that a "newest N" list misses.
  // With no ids, fall back to a broad newest-100 org list. Origin/org/creators
  // scope is preserved from the recorded request.
  var url = base;
  try {
    var u = new URL(base, "https://app.devin.ai");
    var p = u.searchParams;
    ["session_ids", "pr_state", "compact", "include_initial_message",
     "updated_date_from", "updated_date_to", "include_pinned", "limit",
     "order_by", "sort_direction"].forEach(function (k) { p.delete(k); });
    if (sessionIds && sessionIds.length) {
      p.set("group_children", "true");
      for (var i = 0; i < sessionIds.length; i++) p.append("session_ids", sessionIds[i]);
    } else {
      p.set("include_pinned", "true");
      p.set("limit", "100");
      p.set("order_by", "updated_at");
      p.set("sort_direction", "desc");
    }
    p.set("is_archived", "false");
    url = u.href;
  } catch (e) {}
  var used = (rec && Object.keys(headers).length) ? "recorded" :
    (window.__dsLastV2SessionsUrl ? "recorded-url" : "fallback");
  var opts = { credentials: "include" };
  if (Object.keys(headers).length) opts.headers = headers;
  var started = Date.now();
  return fetch(url, opts).then(function (r) {
    var ct = r.headers.get("content-type") || "";
    if (!r.ok || !/json|text/i.test(ct)) {
      return { ok: r.ok, status: r.status, url: url, used: used };
    }
    return r.text().then(function (body) {
      // Ship the FULL (untruncated) body straight to the sink through the same
      // window bridge inject.js uses (content.js relays it). inject.js also
      // captures this fetch but truncates it to 24KB; this whole copy
      // supersedes it (sink is newest-timestamp-wins), so the sink folds EVERY
      // session named in the org-wide list, not just the ~5 that fit 24KB.
      // Self-contained: does not depend on which inject.js build the tab runs.
      try {
        window.postMessage({
          __devinStream: "devin-stream-net",
          payload: {
            channel: "fetch", url: url, method: "GET",
            status: r.status, contentType: ct,
            ms: Date.now() - started, body: body,
          },
        }, window.location.origin);
      } catch (e) {}
      return { ok: true, status: r.status, url: url, used: used, bytes: body.length };
    });
  }).catch(function (e) {
    return { ok: false, status: 0, url: url, used: used, error: String(e) };
  });
}

// Bound the fan-out. We stop at the first authenticated success, so this cap
// only matters while no tab has an authenticated request recorded yet (all
// attempts 401, harmlessly). Set high enough to reach whichever tab is running
// the header-recording inject.js among many open session tabs.
var POLL_MAX_TABS = 50;
var POLL_MAX_IDS = 100; // keep the batch URL a sane length

// devin_ids of every open app.devin.ai/sessions/<id> tab, so the poll requests
// exactly the sessions window-colors is tracking (not just the newest N).
async function openSessionIds() {
  try {
    var tabs = await chrome.tabs.query({ url: "https://app.devin.ai/sessions/*" });
    var seen = {}, ids = [];
    for (var i = 0; i < tabs.length; i++) {
      var m = /\/sessions\/([a-f0-9]{8,})/i.exec(tabs[i].url || "");
      if (m) {
        var id = "devin-" + m[1];
        if (!seen[id]) { seen[id] = 1; ids.push(id); }
      }
    }
    return ids.slice(0, POLL_MAX_IDS);
  } catch (e) {
    return [];
  }
}

// Shared poll driver: walk the candidate tabs and replay one batched
// v2sessions request for `ids` (or the broad newest-100 list when empty),
// stopping at the first authenticated success. Used by both the fast
// active poll (open tabs' sessions) and the slow dormant backfill.
async function runV2Poll(ids, eventName) {
  var tabs = await candidatePollTabs();
  if (!tabs.length) {
    sinkEvent({ event: eventName, ok: false, reason: "no-tab", bootId: BOOT_ID });
    return;
  }
  var fallback = fallbackV2Url();
  var last = null, tried = 0;
  for (var i = 0; i < tabs.length && tried < POLL_MAX_TABS; i++) {
    var tab = tabs[i];
    tried++;
    var res;
    try {
      var out = await chrome.scripting.executeScript({
        target: { tabId: tab.id }, world: "MAIN",
        func: activePollFn, args: [fallback, ids],
      });
      res = (out && out[0]) ? out[0].result : { ok: false, reason: "no-result" };
    } catch (e) {
      res = { ok: false, error: String(e) };
    }
    last = Object.assign({ tabId: tab.id, tabUrl: tab.url }, res || {});
    // Remember the best attempt (an authenticated recorded replay) even if it
    // ultimately errored, so the audit log shows how far we got.
    if (res && res.used === "recorded") last.sawRecorded = true;
    // Stop at the first authenticated success -- one org-wide refresh is enough.
    if (res && res.ok) { lastGoodPollTabId = tab.id; break; }
  }
  sinkEvent(Object.assign(
    { event: eventName, tried: tried, ids: (ids || []).length },
    last || {}, { bootId: BOOT_ID }));
}

async function pollV2Sessions() {
  return runV2Poll(await openSessionIds(), "active-poll");
}

chrome.alarms.create("poll-v2sessions", { periodInMinutes: 2.5 });

// ── Dormant-session backfill ─────────────────────────────────────────────────
// The active poll only refreshes the sessions with an OPEN tab, so sessions
// whose tab was closed keep stale PR/status data in the sink forever (until
// manually revisited). This slow rolling backfill fixes that: every cycle it
// asks the sink for every session id it has ever summarized, keeps the ones
// that are DORMANT (no open tab AND not observed recently -- recently-seen
// ids are already covered by the active poll / live capture), and replays
// one batched v2sessions request for the next BACKFILL_BATCH of them,
// rotating alphabetically via a persisted cursor so the whole backlog cycles
// through over time (~70 dormant ids / 40 per 5-min cycle ≈ a full refresh
// every ~10 min; a 1000-id backlog would still cycle in ~2h). Exactly one
// batched request per cycle -- same authenticated MAIN-world fetch + full-
// body capture path as the active poll, so the response folds through the
// sink's locked ingest path and authoritatively refreshes PR sets/status.
// Growth note: the id universe is the sink's summary (every session ever
// captured, currently ~1200); it only grows as the user creates sessions,
// and a bigger backlog just means a longer rotation, never more than one
// request per cycle -- so no hard cap is enforced here.
var BACKFILL_PERIOD_MIN = 5;
var BACKFILL_BATCH = 40;
var BACKFILL_DORMANT_MS = 15 * 60 * 1000; // observed more recently = skip
var SESSION_IDS_URL = "http://127.0.0.1:48292/session-ids";

// Sink timestamps are ISO with a colon-less offset ("-0700"); normalize for
// Date.parse.
function parseSinkTs(ts) {
  if (!ts) return NaN;
  return Date.parse(String(ts).replace(/([+-]\d{2})(\d{2})$/, "$1:$2"));
}

async function backfillDormantSessions() {
  var known;
  try {
    var res = await fetch(SESSION_IDS_URL);
    if (!res.ok) return;
    known = (await res.json()).ids || [];
  } catch (e) {
    return; // sink not running
  }
  var open = {};
  (await openSessionIds()).forEach(function (id) { open[id] = 1; });
  var now = Date.now();
  var dormant = [];
  for (var i = 0; i < known.length; i++) {
    var id = "devin-" + known[i].id;
    if (open[id]) continue;
    var seen = parseSinkTs(known[i].lastSeen);
    if (isFinite(seen) && now - seen < BACKFILL_DORMANT_MS) continue;
    dormant.push(id);
  }
  if (!dormant.length) return;
  dormant.sort(); // stable order so the rotating cursor cycles everything
  var store = await chrome.storage.local.get("backfillCursor");
  var cursor = store.backfillCursor || 0;
  if (cursor >= dormant.length) cursor = 0;
  var batch = dormant.slice(cursor, cursor + BACKFILL_BATCH);
  if (batch.length < BACKFILL_BATCH) {
    batch = batch.concat(dormant.slice(0, BACKFILL_BATCH - batch.length));
  }
  await chrome.storage.local.set({
    backfillCursor: (cursor + batch.length) % dormant.length,
  });
  await runV2Poll(batch.slice(0, POLL_MAX_IDS), "backfill-poll");
}

chrome.alarms.create("backfill-v2sessions", { periodInMinutes: BACKFILL_PERIOD_MIN });

chrome.alarms.onAlarm.addListener(function (alarm) {
  if (alarm.name === "poll-v2sessions") pollV2Sessions();
  if (alarm.name === "backfill-v2sessions") backfillDormantSessions();
});

// ── Boot ────────────────────────────────────────────────────────────────────

injectIntoOpenTabs().then(function (n) {
  sinkEvent({ event: "worker-start", bootId: BOOT_ID, injected: n });
  // Prime the status refresh immediately rather than waiting for the first
  // alarm ~2.5 min out.
  pollV2Sessions();
});

chrome.runtime.onInstalled.addListener(function (details) {
  sinkEvent({ event: "installed", reason: details.reason, bootId: BOOT_ID });
  injectIntoOpenTabs();
});
