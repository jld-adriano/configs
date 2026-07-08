// MAIN-world network interceptor for app.devin.ai.
//
// Runs in the page's own JS world (manifest world:"MAIN"), so it can wrap the
// real window.fetch / XMLHttpRequest / WebSocket / EventSource that the Devin
// SPA uses. This is the richest live channel: the streaming session messages,
// agent status, and "next action" proposals all flow through here in real time.
// Captured payloads are truncated and handed to the ISOLATED content script via
// window.postMessage; it relays them to the background worker and on to the sink.
//
// This script only observes -- it never blocks, rewrites, or delays traffic.

(function () {
  if (window.__devinStreamNet) return; // guard against double injection
  window.__devinStreamNet = true;

  var TAG = "devin-stream-net";
  var MAX_BODY = 24000; // hard truncation per captured body (chars)
  var MAX_WS_FRAME = 24000;

  function post(data) {
    try {
      window.postMessage({ __devinStream: TAG, payload: data }, window.location.origin);
    } catch (e) {}
  }

  function clip(s) {
    if (typeof s !== "string") return s;
    return s.length > MAX_BODY ? s.slice(0, MAX_BODY) + "\u2026[+" + (s.length - MAX_BODY) + "]" : s;
  }

  // Only capture bodies for Devin's own API/host traffic; skip static assets,
  // analytics, and cross-origin noise to keep volume sane.
  function interesting(url) {
    try {
      var u = new URL(url, window.location.href);
      if (!/devin\.ai$/.test(u.hostname) && u.hostname !== window.location.hostname) return false;
      if (/\.(js|css|png|jpe?g|svg|woff2?|ico|map)(\?|$)/i.test(u.pathname)) return false;
      return true;
    } catch (e) {
      return false;
    }
  }

  // ── fetch ──────────────────────────────────────────────────────────────
  var realFetch = window.fetch;
  if (realFetch) {
    window.fetch = function (input, init) {
      var url = typeof input === "string" ? input : (input && input.url) || "";
      var method = (init && init.method) || (input && input.method) || "GET";
      var started = Date.now();
      var p = realFetch.apply(this, arguments);
      if (interesting(url)) {
        p.then(function (resp) {
          try {
            var ct = resp.headers.get("content-type") || "";
            // Only read text/JSON bodies; clone so the app still gets its copy.
            if (/json|text|event-stream|ndjson/i.test(ct)) {
              resp.clone().text().then(function (body) {
                post({
                  channel: "fetch", url: url, method: method,
                  status: resp.status, contentType: ct,
                  ms: Date.now() - started, body: clip(body),
                });
              }).catch(function () {});
            } else {
              post({ channel: "fetch", url: url, method: method, status: resp.status, contentType: ct, ms: Date.now() - started });
            }
          } catch (e) {}
        }).catch(function () {});
      }
      return p;
    };
  }

  // ── XMLHttpRequest ───────────────────────────────────────────────────────
  var RealXHR = window.XMLHttpRequest;
  if (RealXHR) {
    var open = RealXHR.prototype.open;
    var send = RealXHR.prototype.send;
    RealXHR.prototype.open = function (method, url) {
      this.__ds = { method: method, url: url, started: Date.now() };
      return open.apply(this, arguments);
    };
    RealXHR.prototype.send = function () {
      var self = this;
      if (self.__ds && interesting(self.__ds.url)) {
        self.addEventListener("load", function () {
          try {
            var ct = self.getResponseHeader && self.getResponseHeader("content-type") || "";
            var body = "";
            if (self.responseType === "" || self.responseType === "text") body = self.responseText || "";
            post({
              channel: "xhr", url: self.__ds.url, method: self.__ds.method,
              status: self.status, contentType: ct,
              ms: Date.now() - self.__ds.started, body: clip(body),
            });
          } catch (e) {}
        });
      }
      return send.apply(this, arguments);
    };
  }

  // ── WebSocket ─────────────────────────────────────────────────────────────
  var RealWS = window.WebSocket;
  if (RealWS) {
    var WrappedWS = function (url, protocols) {
      var ws = protocols !== undefined ? new RealWS(url, protocols) : new RealWS(url);
      var track = interesting(url) || /devin/i.test(String(url));
      if (track) {
        post({ channel: "ws", event: "open", url: String(url) });
        ws.addEventListener("message", function (ev) {
          var d = ev.data;
          if (typeof d === "string") {
            post({ channel: "ws", event: "message", url: String(url), body: d.length > MAX_WS_FRAME ? d.slice(0, MAX_WS_FRAME) + "\u2026" : d });
          } else {
            post({ channel: "ws", event: "message", url: String(url), binary: true });
          }
        });
        ws.addEventListener("close", function (ev) {
          post({ channel: "ws", event: "close", url: String(url), code: ev.code });
        });
        var realSend = ws.send;
        ws.send = function (data) {
          if (typeof data === "string") {
            post({ channel: "ws", event: "send", url: String(url), body: data.length > MAX_WS_FRAME ? data.slice(0, MAX_WS_FRAME) + "\u2026" : data });
          }
          return realSend.apply(this, arguments);
        };
      }
      return ws;
    };
    WrappedWS.prototype = RealWS.prototype;
    WrappedWS.CONNECTING = RealWS.CONNECTING;
    WrappedWS.OPEN = RealWS.OPEN;
    WrappedWS.CLOSING = RealWS.CLOSING;
    WrappedWS.CLOSED = RealWS.CLOSED;
    window.WebSocket = WrappedWS;
  }

  // ── EventSource (SSE) ──────────────────────────────────────────────────────
  var RealES = window.EventSource;
  if (RealES) {
    var WrappedES = function (url, config) {
      var es = config !== undefined ? new RealES(url, config) : new RealES(url);
      if (interesting(url)) {
        post({ channel: "sse", event: "open", url: String(url) });
        es.addEventListener("message", function (ev) {
          var d = typeof ev.data === "string" ? ev.data : "";
          post({ channel: "sse", event: "message", url: String(url), body: d.length > MAX_WS_FRAME ? d.slice(0, MAX_WS_FRAME) + "\u2026" : d });
        });
      }
      return es;
    };
    WrappedES.prototype = RealES.prototype;
    window.EventSource = WrappedES;
  }

  post({ channel: "meta", event: "interceptor-installed", href: window.location.href });
})();
