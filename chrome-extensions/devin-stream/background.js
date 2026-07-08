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

// ── Boot ────────────────────────────────────────────────────────────────────

injectIntoOpenTabs().then(function (n) {
  sinkEvent({ event: "worker-start", bootId: BOOT_ID, injected: n });
});

chrome.runtime.onInstalled.addListener(function (details) {
  sinkEvent({ event: "installed", reason: details.reason, bootId: BOOT_ID });
  injectIntoOpenTabs();
});
