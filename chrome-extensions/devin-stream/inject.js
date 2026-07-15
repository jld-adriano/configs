// MAIN-world network interceptor for app.devin.ai.
//
// Runs in the page's own JS world (manifest world:"MAIN"), so it can wrap the
// real window.fetch / XMLHttpRequest / WebSocket / EventSource that the Devin
// SPA uses. This is the richest live channel: the streaming session messages,
// agent status, and "next action" proposals all flow through here in real time.
// Captured payloads are truncated and handed to the ISOLATED content script via
// window.postMessage; it relays them to the background worker and on to the sink.
//
// In addition to observing, this script exposes one narrowly-scoped command:
// window-colors may ask it to send an exact user_message through the OPEN live
// socket for the session currently shown in this tab. Socket/token details
// never leave MAIN world.

(function () {
  // A permanent boolean guard wedges long-lived pages after an unpacked
  // extension reload: the page global survives, so a newer interceptor can
  // never replace the old wrappers. Keep an explicit versioned installation
  // with a reversible cleanup instead. Existing sockets cannot be adopted
  // retroactively; background.js's history refresh repairs that gap.
  var VERSION = "2026-07-15.2";
  var TAG = "devin-stream-net";
  var SEND_REQUEST_TAG = "window-colors-devin-send-v1";
  var SEND_RESPONSE_TAG = "window-colors-devin-send-result-v1";
  var previous = window.__devinStreamNetState;
  if (previous && previous.version === VERSION) {
    try {
      window.postMessage({
        __devinStream: TAG,
        payload: {
          channel: "meta", event: "interceptor-already-current",
          version: VERSION, href: window.location.href,
        },
      }, window.location.origin);
    } catch (e) {}
    return;
  }
  if (previous && typeof previous.cleanup === "function") {
    try { previous.cleanup(); } catch (e) {}
  }
  // Newer builds retain socket references across extension reinjection. The
  // first upgrade from a build that did not retain them still needs one page
  // reload so WrappedWS can observe the socket as it is constructed.
  var inheritedSockets = previous && Array.isArray(previous.sockets)
    ? previous.sockets : [];
  var inheritedResults = previous && previous.sendResults
    ? previous.sendResults : {};
  var state = {
    version: VERSION,
    sockets: inheritedSockets,
    sendResults: inheritedResults,
    sendResultOrder: previous && Array.isArray(previous.sendResultOrder)
      ? previous.sendResultOrder : [],
  };
  window.__devinStreamNetState = state;
  window.__devinStreamNet = VERSION; // compatibility/diagnostics

  var MAX_BODY = 24000; // hard truncation per captured body (chars)
  var MAX_WS_FRAME = 24000;
  var MAX_REQ_BODY = 3000; // truncation for captured OUTGOING request bodies

  function post(data) {
    try {
      window.postMessage({ __devinStream: TAG, payload: data }, window.location.origin);
    } catch (e) {}
  }

  function clip(s) {
    if (typeof s !== "string") return s;
    return s.length > MAX_BODY ? s.slice(0, MAX_BODY) + "\u2026[+" + (s.length - MAX_BODY) + "]" : s;
  }

  function currentSessionId() {
    var m = window.location.href.match(
      /app\.devin\.ai\/sessions\/([a-f0-9]{8,})/i);
    return m ? m[1].toLowerCase() : null;
  }

  function socketSessionId(url) {
    var m = String(url || "").match(
      /\/api\/events\/devin-([a-f0-9]{8,})\/live(?:[/?]|$)/i);
    return m ? m[1].toLowerCase() : null;
  }

  function eventId() {
    var id = "";
    try {
      if (crypto && typeof crypto.randomUUID === "function") {
        id = crypto.randomUUID().replace(/-/g, "");
      } else if (crypto && typeof crypto.getRandomValues === "function") {
        var bytes = new Uint8Array(16);
        crypto.getRandomValues(bytes);
        for (var i = 0; i < bytes.length; i++) {
          id += bytes[i].toString(16).padStart(2, "0");
        }
      }
    } catch (e) {}
    if (!/^[a-f0-9]{32}$/i.test(id)) {
      id = Date.now().toString(16).padStart(12, "0") +
        Math.random().toString(16).slice(2).padEnd(20, "0").slice(0, 20);
    }
    return "event-" + id.slice(0, 32);
  }

  function sendResult(requestId, result) {
    try {
      window.postMessage(Object.assign({
        __wcDevinSendResult: SEND_RESPONSE_TAG,
        requestId: requestId,
      }, result), window.location.origin);
    } catch (e) {}
  }

  function rememberSendResult(requestId, result) {
    if (!requestId) return;
    state.sendResults[requestId] = result;
    state.sendResultOrder.push(requestId);
    while (state.sendResultOrder.length > 100) {
      delete state.sendResults[state.sendResultOrder.shift()];
    }
  }

  function noteSendDiagnostic(data) {
    post(Object.assign({
      channel: "send-diagnostic",
      source: "window-colors",
      at: new Date().toISOString(),
    }, data));
  }

  function onSafeSendRequest(ev) {
    if (ev.source !== window) return;
    var req = ev.data;
    if (!req || req.__wcDevinSendRequest !== SEND_REQUEST_TAG) return;
    var requestId = typeof req.requestId === "string"
      ? req.requestId.slice(0, 120) : "";
    var sid = typeof req.sessionId === "string"
      ? req.sessionId.toLowerCase() : "";
    var message = req.message;
    var baseDiag = {
      requestId: requestId,
      sessionId: sid || null,
      intendedLength: typeof message === "string" ? message.length : null,
      strategy: "matching-open-websocket",
      domComposerTouched: false,
    };
    if (requestId && state.sendResults[requestId]) {
      noteSendDiagnostic(Object.assign({}, baseDiag, {
        success: true,
        code: "duplicate-request-reconciled",
        originalCode: state.sendResults[requestId].code,
      }));
      sendResult(requestId, state.sendResults[requestId]);
      return;
    }
    function fail(code, error) {
      noteSendDiagnostic(Object.assign({}, baseDiag, {
        success: false, code: code, error: error,
      }));
      sendResult(requestId, { ok: false, code: code, error: error });
    }
    if (!requestId || !/^[a-f0-9]{8,}$/i.test(sid) ||
        typeof message !== "string" || !message.trim() ||
        message.length > 200000) {
      fail("invalid-request", "Invalid safe-send request");
      return;
    }
    if (currentSessionId() !== sid) {
      fail("session-mismatch", "Tab is no longer on the requested session");
      return;
    }
    var openState = RealWS && typeof RealWS.OPEN === "number"
      ? RealWS.OPEN : 1;
    var matches = state.sockets.filter(function (entry) {
      return entry && entry.socket &&
        socketSessionId(entry.url) === sid &&
        entry.socket.readyState === openState;
    });
    if (!matches.length) {
      fail("no-open-socket",
        "No matching open Devin live socket; reload this tab to enable safe send");
      return;
    }
    var chosen = matches[matches.length - 1];
    var eid = eventId();
    var frame = {
      type: "user_message",
      message: message,
      origin: "web",
      ensure_awake: true,
      event_id: eid,
      rich_content: [{ text: message }],
    };
    var wire = JSON.stringify(frame);
    try {
      chosen.socket.send(wire);
      noteSendDiagnostic(Object.assign({}, baseDiag, {
        success: true,
        code: "sent",
        eventId: eid,
        wireLength: wire.length,
        socketReadyState: chosen.socket.readyState,
      }));
      var successResult = {
        ok: true,
        code: "sent",
        eventId: eid,
        messageLength: message.length,
        wireLength: wire.length,
      };
      rememberSendResult(requestId, successResult);
      sendResult(requestId, successResult);
    } catch (e) {
      fail("socket-send-error", String(e));
    }
  }

  window.addEventListener("message", onSafeSendRequest);

  // Remember the exact v2sessions list request the app itself last made -- URL
  // AND request headers -- so the active poller (background.js -> executeScript)
  // can replay it verbatim. The URL keeps params current (rolling date window,
  // current session ids); the headers carry the app's auth (v2sessions returns
  // 401 to a bare credentials-only fetch -- it needs the Authorization header
  // the SPA attaches from its in-memory token). Only GET list requests are
  // recorded. Headers stay on `window` (same origin as the app, which already
  // holds this token) and are NEVER shipped to the sink.
  function headersToObj(h) {
    var out = {};
    try {
      if (!h) return out;
      if (typeof Headers !== "undefined" && h instanceof Headers) {
        h.forEach(function (v, k) { out[k] = v; });
      } else if (Array.isArray(h)) {
        h.forEach(function (p) { if (p && p.length === 2) out[p[0]] = p[1]; });
      } else if (typeof h === "object") {
        Object.keys(h).forEach(function (k) { out[k] = h[k]; });
      }
    } catch (e) {}
    return out;
  }

  // Only the headers needed to authenticate/route the replayed request are
  // kept -- notably `authorization` (the SPA's in-memory bearer). Datadog/
  // trace headers are dropped so the replay doesn't pollute the app's tracing.
  var V2_HEADER_KEEP = { "authorization": 1, "x-cog-org-id": 1, "accept": 1 };

  // Prefer the broadest-coverage v2sessions request the app makes so one poll
  // re-observes as many sessions as possible: the pinned/full list and the
  // explicit session_ids batch describe many sessions; the incremental
  // "updated since <recent>" delta poll usually returns almost nothing. Rank
  // by breadth and only replace the stored request with an equal-or-broader
  // one (equal rank still refreshes, keeping auth headers current).
  function v2Rank(u) {
    // Broadest first. The session_ids batch enumerates ~every open session
    // explicitly (best coverage of the tabs window-colors tracks), so it wins
    // over the 30-item pinned list, which wins over a plain list, which wins
    // over the near-empty "updated since <recent>" delta poll.
    if (/[?&]session_ids=/.test(u)) return 4;
    if (/[?&]include_pinned=true/.test(u)) return 3;
    if (/sort_direction=asc/.test(u) && /updated_date_from=/.test(u)) return 1;
    return 2;
  }

  function recordV2(url, method, input, init) {
    if (method && !/^get$/i.test(method)) return;
    try {
      var u = new URL(url, window.location.href);
      if (!/\/v2sessions$/.test(u.pathname)) return;
      var rank = v2Rank(u.href);
      var prev = window.__dsLastV2SessionsReq;
      if (prev && prev.rank > rank) return; // keep the broader request
      window.__dsLastV2SessionsUrl = u.href;
      var raw = {};
      if (input && typeof input === "object" && input.headers) {
        Object.assign(raw, headersToObj(input.headers));
      }
      if (init && init.headers) Object.assign(raw, headersToObj(init.headers));
      var headers = {};
      Object.keys(raw).forEach(function (k) {
        if (V2_HEADER_KEEP[k.toLowerCase()]) headers[k] = raw[k];
      });
      window.__dsLastV2SessionsReq = { url: u.href, headers: headers, rank: rank };
    } catch (e) {}
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

  // Capture OUTGOING request bodies (chat sends etc.) as their own records.
  // The sink turns send-message bodies into an immediate human message for
  // the session instead of waiting for the server to echo it back. Datadog
  // /intake/ beacons are excluded (high volume, compressed, never chat).
  function postRequest(url, method, body) {
    if (typeof body !== "string" || !body) return;
    post({
      channel: "request", url: url, method: method,
      body: body.length > MAX_REQ_BODY
        ? body.slice(0, MAX_REQ_BODY) + "\u2026[+" + (body.length - MAX_REQ_BODY) + "]"
        : body,
    });
  }

  function captureRequestBody(url, method, input, init) {
    try {
      if (!/^(POST|PUT|PATCH)$/i.test(method || "")) return;
      if (!interesting(url) || /\/intake\//.test(url)) return;
      var body = init && init.body;
      if (typeof body === "string") {
        postRequest(url, method, body);
      } else if (typeof URLSearchParams !== "undefined" && body instanceof URLSearchParams) {
        postRequest(url, method, String(body));
      } else if (!body && input && typeof input === "object"
                 && typeof input.clone === "function" && typeof input.text === "function") {
        // Request-object form: body is only reachable async via clone().
        input.clone().text().then(function (b) { postRequest(url, method, b); }).catch(function () {});
      }
    } catch (e) {}
  }

  // ── fetch ──────────────────────────────────────────────────────────────
  var realFetch = window.fetch;
  if (realFetch) {
    var wrappedFetch = function (input, init) {
      var url = typeof input === "string" ? input : (input && input.url) || "";
      var method = (init && init.method) || (input && input.method) || "GET";
      recordV2(url, method, input, init);
      captureRequestBody(url, method, input, init);
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
    state.realFetch = realFetch;
    state.wrappedFetch = wrappedFetch;
    window.fetch = wrappedFetch;
  }

  // ── XMLHttpRequest ───────────────────────────────────────────────────────
  var RealXHR = window.XMLHttpRequest;
  if (RealXHR) {
    var open = RealXHR.prototype.open;
    var send = RealXHR.prototype.send;
    var wrappedOpen = function (method, url) {
      this.__ds = { method: method, url: url, started: Date.now() };
      recordV2(url, method);
      return open.apply(this, arguments);
    };
    var wrappedSend = function (data) {
      var self = this;
      if (self.__ds && typeof data === "string") {
        captureRequestBody(self.__ds.url, self.__ds.method, null, { body: data });
      }
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
    state.realXHR = RealXHR;
    state.xhrOpen = open;
    state.xhrSend = send;
    state.wrappedXhrOpen = wrappedOpen;
    state.wrappedXhrSend = wrappedSend;
    RealXHR.prototype.open = wrappedOpen;
    RealXHR.prototype.send = wrappedSend;
  }

  // ── WebSocket ─────────────────────────────────────────────────────────────
  var RealWS = window.WebSocket;
  if (RealWS) {
    var WrappedWS = function (url, protocols) {
      var ws = protocols !== undefined ? new RealWS(url, protocols) : new RealWS(url);
      var track = interesting(url) || /devin/i.test(String(url));
      if (track) {
        state.sockets.push({
          socket: ws, url: String(url), createdAt: Date.now(),
        });
        // Bound stale references without risking removal of active sockets.
        if (state.sockets.length > 100) {
          state.sockets = state.sockets.filter(function (entry) {
            return entry && entry.socket &&
              entry.socket.readyState !== RealWS.CLOSED;
          }).slice(-100);
        }
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
    state.realWS = RealWS;
    state.wrappedWS = WrappedWS;
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
    state.realES = RealES;
    state.wrappedES = WrappedES;
    window.EventSource = WrappedES;
  }

  state.cleanup = function () {
    try {
      window.removeEventListener("message", onSafeSendRequest);
      if (state.wrappedFetch && window.fetch === state.wrappedFetch) {
        window.fetch = state.realFetch;
      }
      if (state.realXHR) {
        if (state.realXHR.prototype.open === state.wrappedXhrOpen) {
          state.realXHR.prototype.open = state.xhrOpen;
        }
        if (state.realXHR.prototype.send === state.wrappedXhrSend) {
          state.realXHR.prototype.send = state.xhrSend;
        }
      }
      if (state.wrappedWS && window.WebSocket === state.wrappedWS) {
        window.WebSocket = state.realWS;
      }
      if (state.wrappedES && window.EventSource === state.wrappedES) {
        window.EventSource = state.realES;
      }
      if (window.__devinStreamNetState === state) {
        delete window.__devinStreamNetState;
        delete window.__devinStreamNet;
      }
    } catch (e) {}
  };

  post({
    channel: "meta", event: "interceptor-installed",
    version: VERSION, href: window.location.href,
  });
})();
