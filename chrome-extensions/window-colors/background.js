// Service worker: central color registry, dev auto-reload, and
// scroll-to-bottom automation for agent tabs (Devin/Capy).

const HEARTBEAT_TIMEOUT_MS = 10 * 60 * 1000; // free a color slot after this
const GOLDEN_ANGLE = 137.508; // degrees; spreads hues maximally

// ── Color registry ──────────────────────────────────────────────────────────
// Keys (e.g. Devin session ids) are assigned the smallest free slot; the slot
// maps to a hue via the golden angle so nearby slots look very different.
// Content scripts heartbeat their key; stale entries are pruned so slots
// (and therefore colors) get reused.

let registry = null; // key -> { slot, lastSeen }

async function loadRegistry() {
  if (registry === null) {
    const data = await chrome.storage.local.get("registry");
    registry = data.registry || {};
  }
  return registry;
}

function pruneRegistry() {
  const now = Date.now();
  for (const [key, entry] of Object.entries(registry)) {
    if (now - entry.lastSeen > HEARTBEAT_TIMEOUT_MS) delete registry[key];
  }
}

function assignSlot(key) {
  pruneRegistry();
  if (registry[key]) {
    registry[key].lastSeen = Date.now();
    return registry[key].slot;
  }
  const used = new Set(Object.values(registry).map((e) => e.slot));
  let slot = 0;
  while (used.has(slot)) slot++;
  registry[key] = { slot, lastSeen: Date.now() };
  return slot;
}

function colorForSlot(slot) {
  const hue = (slot * GOLDEN_ANGLE) % 360;
  // Once hues wrap around, vary lightness so repeats still look different.
  const cycle = Math.floor((slot * GOLDEN_ANGLE) / 360);
  const lightness = [55, 38, 70][cycle % 3];
  return `hsl(${hue}, 75%, ${lightness}%)`;
}

// Stable per-thread symbol: indexed by the same registry slot as the color,
// so active threads never share a symbol until the list wraps.
const SYMBOLS = [
  "⚔️", "🛡️", "🐉", "🔥", "⚡", "🌊", "🎯", "🚀", "🧭", "⚓",
  "🎲", "🗝️", "💎", "🪐", "🌵", "🍄", "🦊", "🐙", "🦅", "🐢",
  "🐝", "🌙", "☀️", "⭐", "🌈", "🍉", "🍕", "⚙️", "🧲", "🔮",
  "🦖", "🏰", "🔔", "🍀", "🥁", "🪁", "🎈", "🧊", "🌋", "🛸",
];

function symbolForSlot(slot) {
  return SYMBOLS[slot % SYMBOLS.length];
}

// Per-tab determinations reported alongside heartbeats; forwarded to the local
// sink (window-colors-sink launchd service) so extension behavior can be
// inspected outside the browser. In-memory only: repopulated by heartbeats
// within 30s of a worker restart.
const tabReports = {};

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // Lightweight memory-only reports from NON-agent tabs (no registry slot);
  // stored alongside heartbeat reports so the sink's `tabs` array covers every
  // tab for the aero-tab-memory ranking.
  if (msg && msg.type === "memreport") {
    if (msg.report && sender.tab && sender.tab.id != null) {
      tabReports[sender.tab.id] = {
        ...msg.report,
        kind: "page",
        tabId: sender.tab.id,
        windowId: sender.tab.windowId,
        reportedAt: Date.now(),
      };
    }
    sendResponse({});
    return false;
  }
  if (msg && msg.type === "heartbeat" && msg.key) {
    loadRegistry().then(() => {
      const slot = assignSlot(msg.key);
      chrome.storage.local.set({ registry });
      const color = colorForSlot(slot);
      const symbol = symbolForSlot(slot);
      if (msg.report && sender.tab && sender.tab.id != null) {
        tabReports[sender.tab.id] = {
          ...msg.report,
          key: msg.key,
          slot,
          color,
          symbol,
          tabId: sender.tab.id,
          windowId: sender.tab.windowId,
          reportedAt: Date.now(),
        };
      }
      sendResponse({ color, slot, symbol });
    });
    return true; // async response
  }
});

// ── State sink reporting ────────────────────────────────────────────────────

const SINK_URL = "http://127.0.0.1:48291/ingest";
const REPORT_STALE_MS = 5 * 60 * 1000;

async function pushStateToSink() {
  const now = Date.now();
  for (const [id, r] of Object.entries(tabReports)) {
    if (now - r.reportedAt > REPORT_STALE_MS) delete tabReports[id];
  }
  await loadRegistry();
  const payload = {
    source: "window-colors",
    registrySize: Object.keys(registry).length,
    registry,
    tabs: Object.values(tabReports),
    awaitingCount: Object.values(tabReports).filter((r) => r.awaiting).length,
  };
  try {
    await fetch(SINK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
  } catch (e) {
    // sink not running; nothing to do
  }
}

chrome.alarms.create("report-state", { periodInMinutes: 0.5 });

// ── Dev auto-reload ─────────────────────────────────────────────────────────
// Unpacked extensions serve files straight from disk, so fetching our own
// files reflects current disk contents. Poll a fingerprint and reload the
// extension when it changes.

const WATCH_FILES = ["manifest.json", "background.js", "content.js", "style.css"];

const RELOAD_COOLDOWN_MS = 3 * 60 * 1000;

async function fileFingerprint() {
  // null = couldn't read everything; callers must skip the comparison. An
  // empty/failed fetch (worker still initializing) once produced a bogus
  // fingerprint here, which made every boot look "changed" -> reload loop.
  const parts = [];
  for (const f of WATCH_FILES) {
    try {
      const t = await (await fetch(chrome.runtime.getURL(f))).text();
      if (!t) return null;
      parts.push(t);
    } catch (e) {
      return null;
    }
  }
  const s = parts.join("\u0000");
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return String(h);
}

chrome.alarms.create("watch-files", { periodInMinutes: 0.5 });

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === "report-state") {
    pushStateToSink();
    return;
  }
  if (alarm.name !== "watch-files") return;
  const fp = await fileFingerprint();
  if (fp === null) return; // unreadable this cycle; try again next tick
  const { fileFp, lastReloadAt } = await chrome.storage.local.get(
    ["fileFp", "lastReloadAt"]);
  if (fileFp === undefined) {
    await chrome.storage.local.set({ fileFp: fp });
  } else if (fileFp !== fp) {
    if (lastReloadAt && Date.now() - lastReloadAt < RELOAD_COOLDOWN_MS) {
      sinkEvent({ event: "reload-suppressed", bootId: BOOT_ID });
      return; // cooldown: break potential reload loops
    }
    await chrome.storage.local.set({ fileFp: fp, lastReloadAt: Date.now() });
    sinkEvent({ event: "reloading", bootId: BOOT_ID });
    chrome.runtime.reload();
  }
});

// ── Inject into already-open tabs ───────────────────────────────────────────
// Manifest content_scripts only run on new page loads, so on install/reload
// push the script+css into every existing http(s) tab. content.js cleans up
// any previous copy of itself before re-installing.

async function injectIntoAllTabs() {
  const tabs = await chrome.tabs.query({});
  const results = await Promise.all(tabs.map(async (tab) => {
    if (!tab.id || !tab.url || !/^https?:/.test(tab.url)) return 0;
    try {
      await chrome.scripting.insertCSS({ target: { tabId: tab.id }, files: ["style.css"] });
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["content.js"] });
      return 1;
    } catch (e) {
      return 0; // chrome:// pages, PDF viewer, etc.
    }
  }));
  return results.reduce((a, b) => a + b, 0);
}

// Fire-and-forget diagnostic events to the sink (visible in state.jsonl).
function sinkEvent(payload) {
  try {
    fetch(SINK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ source: "window-colors", ...payload }),
    }).catch(() => {});
  } catch (e) {}
}

// Run on every service-worker start, not just onInstalled: after
// chrome.runtime.reload() the old content-script contexts are invalidated
// (their heartbeats die silently), and relying on onInstalled alone proved
// flaky. Re-injection is idempotent thanks to the __wcCleanup guard.
const BOOT_ID = Date.now().toString(36);
injectIntoAllTabs().then((n) => {
  sinkEvent({ event: "worker-start", bootId: BOOT_ID, injected: n });
});

chrome.runtime.onInstalled.addListener((details) => {
  sinkEvent({ event: "installed", reason: details.reason, bootId: BOOT_ID });
  injectIntoAllTabs();
});

// ── Scroll agent tabs to bottom (Cmd+Shift+9) ───────────────────────────────
// Works on background tabs too, so one trigger covers every workspace.

const AGENT_URLS = ["app.devin.ai", "capy.ai"];

function scrollPageToBottom() {
  window.scrollTo(0, document.body.scrollHeight);
  // SPAs usually scroll an inner container, not the window: push every
  // scrollable element to its bottom.
  for (const el of document.querySelectorAll("*")) {
    if (el.scrollHeight > el.clientHeight + 10) el.scrollTop = el.scrollHeight;
  }
}

async function scrollAgentTabs() {
  const tabs = await chrome.tabs.query({});
  for (const tab of tabs) {
    if (!tab.id || !tab.url) continue;
    if (!AGENT_URLS.some((h) => tab.url.includes(h))) continue;
    try {
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: scrollPageToBottom,
      });
    } catch (e) {
      // tab may be discarded/unloadable -- ignore
    }
  }
}

chrome.commands.onCommand.addListener((command) => {
  if (command === "scroll-agents-bottom") scrollAgentTabs();
});
