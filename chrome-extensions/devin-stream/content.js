// ISOLATED-world content script for app.devin.ai.
//
// Three jobs:
//   1. Relay network captures from the MAIN-world interceptor (inject.js) to the
//      background worker.
//   2. Discovery/inventory mode: enumerate IndexedDB databases/object stores/
//      record counts + truncated samples, and dump localStorage keys/samples,
//      then ship them so IndexedDB schema iteration can continue from outside
//      the browser after the extension is loaded.
//   3. Lightweight per-session context (session id, title, awaiting state).
//
// A content script shares the host page's origin, so indexedDB / localStorage
// here read the SAME data the Devin app reads. Values in Devin's IndexedDB are
// structured-clone serialized on disk (unreadable via `strings`), but reading
// them through the live indexedDB API here yields fully-decoded objects.

(function () {
  if (window.__devinStreamContent) return;
  window.__devinStreamContent = true;

  var SAMPLE_RECORDS = 3;        // records sampled per object store
  var SAMPLE_CHARS = 1500;       // truncation per sampled record (chars)
  var LS_SAMPLE_KEYS = 120;      // localStorage keys to enumerate
  var LS_SAMPLE_CHARS = 800;
  var DISCOVERY_PERIOD_MS = 60000;
  var NET_FLUSH_MS = 1500;

  function sessionId() {
    var m = location.href.match(/app\.devin\.ai\/sessions\/([a-f0-9-]{8,})/i);
    return m ? m[1] : null;
  }

  function sessionTitle() {
    var t = document.title || "";
    return t.replace(/\s*[-|\u00b7]\s*Devin.*$/i, "").trim() || null;
  }

  var AWAIT_PATTERNS = [
    /waiting for instructions/i, /action required/i,
    /devin went to sleep/i, /devin is waiting/i, /awaiting your/i,
  ];
  function isAwaiting() {
    var text = document.body ? document.body.innerText : "";
    return AWAIT_PATTERNS.some(function (p) { return p.test(text); });
  }

  function send(kind, data) {
    try {
      chrome.runtime.sendMessage({
        type: "devin-stream",
        kind: kind,
        sessionId: sessionId(),
        url: location.href,
        data: data,
      }, function () { void chrome.runtime.lastError; });
    } catch (e) {
      // extension context invalidated (reload in progress); next tick recovers
    }
  }

  // ── 1. Relay MAIN-world network captures ──────────────────────────────────
  var netQueue = [];
  window.addEventListener("message", function (ev) {
    if (ev.source !== window) return;
    var d = ev.data;
    if (!d || d.__devinStream !== "devin-stream-net" || !d.payload) return;
    netQueue.push(d.payload);
    if (netQueue.length > 200) netQueue.shift();
  });

  function flushNet() {
    if (!netQueue.length) return;
    var batch = netQueue.splice(0, netQueue.length);
    var sid = sessionId();
    var events = batch.map(function (p) {
      return { source: "devin-stream", kind: "net", sessionId: sid, url: location.href, data: p };
    });
    try {
      chrome.runtime.sendMessage({ type: "devin-stream-batch", events: events },
        function () { void chrome.runtime.lastError; });
    } catch (e) {}
  }
  setInterval(flushNet, NET_FLUSH_MS);

  // ── 2. IndexedDB + localStorage discovery ─────────────────────────────────
  function openDb(name) {
    return new Promise(function (resolve) {
      var req;
      try { req = indexedDB.open(name); } catch (e) { return resolve(null); }
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { resolve(null); };
      req.onblocked = function () { resolve(null); };
    });
  }

  function countStore(db, storeName) {
    return new Promise(function (resolve) {
      var out = { store: storeName, count: null, keyPath: null, samples: [] };
      var tx, store;
      try {
        tx = db.transaction(storeName, "readonly");
        store = tx.objectStore(storeName);
        out.keyPath = store.keyPath || null;
      } catch (e) {
        return resolve(out);
      }
      var cr = store.count();
      cr.onsuccess = function () { out.count = cr.result; };
      // Sample the first few records via a cursor, truncating each.
      var n = 0;
      var curReq = store.openCursor();
      curReq.onsuccess = function (e) {
        var cur = e.target.result;
        if (!cur || n >= SAMPLE_RECORDS) return resolve(out);
        var val;
        try {
          val = JSON.stringify(cur.value);
        } catch (err) {
          val = String(cur.value);
        }
        if (val && val.length > SAMPLE_CHARS) val = val.slice(0, SAMPLE_CHARS) + "\u2026";
        out.samples.push({ key: String(cur.key), value: val });
        n++;
        cur.continue();
      };
      curReq.onerror = function () { resolve(out); };
    });
  }

  async function inventoryIndexedDB() {
    var dbsMeta = [];
    var names = [];
    try {
      if (indexedDB.databases) {
        var list = await indexedDB.databases();
        names = list.map(function (d) { return d.name; }).filter(Boolean);
      }
    } catch (e) {}
    for (var i = 0; i < names.length; i++) {
      var db = await openDb(names[i]);
      if (!db) { dbsMeta.push({ name: names[i], error: "open-failed" }); continue; }
      var stores = [];
      var storeNames = Array.prototype.slice.call(db.objectStoreNames || []);
      for (var j = 0; j < storeNames.length; j++) {
        stores.push(await countStore(db, storeNames[j]));
      }
      dbsMeta.push({ name: db.name, version: db.version, stores: stores });
      try { db.close(); } catch (e) {}
    }
    return dbsMeta;
  }

  function inventoryLocalStorage() {
    var out = { keys: [], samples: [] };
    try {
      var n = Math.min(localStorage.length, LS_SAMPLE_KEYS);
      for (var i = 0; i < n; i++) {
        var k = localStorage.key(i);
        out.keys.push(k);
        if (/session|chat|msg|active|tab|input|pending|member|task/i.test(k)) {
          var v = localStorage.getItem(k) || "";
          out.samples.push({ key: k, len: v.length, value: v.slice(0, LS_SAMPLE_CHARS) });
        }
      }
    } catch (e) {
      out.error = String(e);
    }
    return out;
  }

  async function runDiscovery() {
    var inv;
    try {
      inv = {
        indexedDB: await inventoryIndexedDB(),
        localStorage: inventoryLocalStorage(),
        sessionStorageKeys: (function () {
          try { return Object.keys(sessionStorage); } catch (e) { return []; }
        })(),
        title: sessionTitle(),
        awaiting: isAwaiting(),
      };
    } catch (e) {
      inv = { error: String(e) };
    }
    send("discovery", inv);
  }

  // ── 3. Session context heartbeat ──────────────────────────────────────────
  var lastContext = "";
  function sessionContext() {
    if (!sessionId()) return;
    var ctx = {
      title: sessionTitle(),
      awaiting: isAwaiting(),
      status: isAwaiting() ? "awaiting" : "active",
    };
    var sig = JSON.stringify(ctx);
    if (sig === lastContext) return;
    lastContext = sig;
    send("session", ctx);
  }

  function boot() {
    runDiscovery();
    sessionContext();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
  setInterval(runDiscovery, DISCOVERY_PERIOD_MS);
  setInterval(sessionContext, 5000);

  window.__devinStreamContentCleanup = function () {};
})();
