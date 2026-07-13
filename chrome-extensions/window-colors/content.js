(function () {
  // Guard: the background worker re-injects this script into open tabs on
  // extension (re)load, so tear down any previous instance first.
  if (window.__wcCleanup) {
    try { window.__wcCleanup(); } catch (e) {}
  }

  // Render/refresh cadence. There is deliberately NO MutationObserver and no
  // per-mutation work: on huge Devin DOMs the old observer (childList+subtree
  // -> tick -> body.innerText/textContent scans) burned CPU and allocated
  // multi-MB strings on every SPA re-render. Everything below is driven by
  // this slow timer plus push events (storage changes, summary responses).
  const RENDER_INTERVAL_MS = 15 * 1000;
  const HEARTBEAT_INTERVAL_MS = 30 * 1000;
  // Visible Devin tabs poll the (background-cached, local) sink summary on a
  // fast cadence so the banner's status line tracks what Devin is doing in
  // near-realtime. Hidden tabs stay on the 30s heartbeat cadence -- dozens of
  // background tabs must not multiply load, and nobody can see them anyway.
  const SUMMARY_FAST_INTERVAL_MS = 8 * 1000;

  function hashToHSL(str) {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      hash = str.charCodeAt(i) + ((hash << 5) - hash);
      hash = hash & hash;
    }
    const hue = Math.abs(hash) % 360;
    return `hsl(${hue}, 70%, 55%)`;
  }

  function isDevinSession() {
    return /app\.devin\.ai\/sessions\/[a-f0-9-]+/.test(window.location.href);
  }

  // A Devin session page counts as "loaded" only once the URL has a session
  // id AND the tab title carries a real session title. During the login/
  // loading splash (and before the SPA hydrates session data) document.title
  // is empty or just "Devin", so the HUD would otherwise render a bogus
  // "Devin" placeholder banner.
  function devinSessionLoaded() {
    if (!isDevinSession()) return false;
    const t = (document.title || "")
      .replace(/\s*[-|·]\s*Devin.*$/i, "")
      .trim();
    return t !== "" && t.toLowerCase() !== "devin";
  }

  function isCapyThread() {
    return /capy\.ai\/project\/[a-f0-9-]+\/thread\/[a-f0-9-]+/.test(
      window.location.href);
  }

  // Capy sets the tab title to "<thread title> | Capy" (observed live via the
  // sink's tab reports); strip the suffix, tolerating a "-"/"·" separator too.
  function getCapyThreadTitle() {
    return (document.title || "")
      .replace(/\s*[-|·]\s*Capy\s*$/i, "")
      .trim();
  }

  // Same gating idea as devinSessionLoaded(): a Capy thread counts as
  // "loaded" only once the tab title carries a real thread title. Pre-load
  // the title is empty or just "Capy", and we must not report that as a
  // session title (or badge the tab yet).
  function capyThreadLoaded() {
    if (!isCapyThread()) return false;
    const t = getCapyThreadTitle();
    return t !== "" && t.toLowerCase() !== "capy";
  }

  function getStableKey() {
    const url = window.location.href;
    // For Devin sessions, use the session ID for stable color
    const devinMatch = url.match(/app\.devin\.ai\/sessions\/([a-f0-9-]+)/);
    if (devinMatch) return devinMatch[1];
    // For Capy threads, use the thread ID
    const capyMatch = url.match(/capy\.ai\/project\/[a-f0-9-]+\/thread\/([a-f0-9-]+)/);
    if (capyMatch) return capyMatch[1];
    // For GitHub PRs, use the PR number
    const prMatch = url.match(/github\.com\/[^/]+\/[^/]+\/pull\/(\d+)/);
    if (prMatch) return prMatch[1];
    // For other URLs, use the hostname + pathname
    try {
      const u = new URL(url);
      return u.hostname + u.pathname;
    } catch {
      return document.title;
    }
  }

  // Hash-fallback symbols, used only until the background registry responds
  // (its reply prefers the sink's LLM-picked symbol; see background.js).
  // Kept in sync with background.js SYMBOLS.
  const FALLBACK_SYMBOLS = [
    "⚔️", "🛡️", "🐉", "🔥", "⚡", "🌊", "🎯", "🚀", "🧭", "⚓",
    "🎲", "🗝️", "💎", "🪐", "🌵", "🍄", "🦊", "🐙", "🦅", "🐢",
    "🐝", "🌙", "☀️", "⭐", "🌈", "🍉", "🍕", "⚙️", "🧲", "🔮",
    "🦖", "🏰", "🔔", "🍀", "🥁", "🪁", "🎈", "🧊", "🌋", "🛸",
    "🦑", "🦩", "🦉", "🐊", "🦔", "🐫", "🦭", "🦋", "🥑", "🌻",
    "🍒", "🥐", "🌮", "🍜", "☕", "🏹", "🪓", "🔭", "🧬", "🎻",
    "🎸", "🎷", "📡", "🗿", "⛵", "🚂", "🏎️", "🪂", "🎡", "⛺",
    "📚", "🖍️", "🧵", "🧸", "🥌", "♟️", "🎨", "🪀", "🪄", "🧩",
  ];

  function hashInt(str) {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      hash = str.charCodeAt(i) + ((hash << 5) - hash);
      hash = hash & hash;
    }
    return Math.abs(hash);
  }

  let assignedColor = null;
  let assignedSymbol = null;

  // Per-tab banner collapse (distinct from the global HUD dot, which hides
  // everything in EVERY tab). Session-scoped: a plain variable that survives
  // the 15s re-renders because updateBanner reads it rather than resetting it.
  // Collapsed = a minimal strip (symbol + the two small title-row icons).
  let bannerHidden = false;

  // Per-tab expanded message row (click-to-expand): index into the banner's
  // message list, -1 = none. Session-scoped like bannerHidden; folded into
  // the render-state key so rebuilds reproduce it, and toggled in place on
  // click (no rebuild) so it works even while the reply input holds text.
  let expandedMsgIdx = -1;

  // ── Global HUD visibility toggle ──────────────────────────────────────────
  // A tiny always-visible dot (bottom-right) hides/shows the badge, banner and
  // awaiting line in EVERY tab. Persisted in chrome.storage.local so one click
  // propagates live via chrome.storage.onChanged.

  let hudHidden = false;

  function renderHudToggle() {
    let dot = document.getElementById("wc-hud-toggle");
    if (!dot) {
      dot = document.createElement("div");
      dot.id = "wc-hud-toggle";
      dot.title = "Toggle window-colors HUD (all tabs)";
      dot.addEventListener("click", () => {
        try {
          chrome.storage.local.set({ hudHidden: !hudHidden });
        } catch (e) {
          // extension context invalidated; flip locally as a fallback
          hudHidden = !hudHidden;
          tick();
        }
      });
      document.documentElement.appendChild(dot);
    }
    dot.classList.toggle("wc-hud-off", hudHidden);
  }

  function onStorageChanged(changes, area) {
    if (area !== "local" || !("hudHidden" in changes)) return;
    hudHidden = !!changes.hudHidden.newValue;
    tick();
  }

  try {
    chrome.storage.local.get("hudHidden", (data) => {
      if (chrome.runtime.lastError) return;
      hudHidden = !!(data && data.hudHidden);
      tick();
    });
    chrome.storage.onChanged.addListener(onStorageChanged);
  } catch (e) {
    // extension context invalidated; HUD stays visible
  }

  function currentColor() {
    return assignedColor || hashToHSL(getStableKey());
  }

  // ── Banner text contrast ──────────────────────────────────────────────────
  // Banner backgrounds are HSL strings we generate ourselves (registry slots
  // and hashToHSL fallbacks), with varying lightness -- bright slots make the
  // hardcoded white text unreadable. Parse the HSL, convert to sRGB, compute
  // WCAG relative luminance, and pick near-black or white text accordingly.
  function contrastStyleFor(bg) {
    let lum = 0; // unparseable -> treat as dark -> white text (old behavior)
    const m = /hsl\(\s*([\d.]+)\s*,\s*([\d.]+)%\s*,\s*([\d.]+)%\s*\)/i
      .exec(bg || "");
    if (m) {
      const h = parseFloat(m[1]) / 360;
      const s = parseFloat(m[2]) / 100;
      const l = parseFloat(m[3]) / 100;
      const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
      const p = 2 * l - q;
      const chan = (t) => {
        t = ((t % 1) + 1) % 1;
        if (t < 1 / 6) return p + (q - p) * 6 * t;
        if (t < 1 / 2) return q;
        if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
        return p;
      };
      const lin = (c) =>
        c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
      lum =
        0.2126 * lin(chan(h + 1 / 3)) +
        0.7152 * lin(chan(h)) +
        0.0722 * lin(chan(h - 1 / 3));
    }
    return lum > 0.5
      ? {
          color: "#111",
          shadow: "0 1px 2px rgba(255, 255, 255, 0.4)",
          separator: "rgba(0, 0, 0, 0.35)",
        }
      : {
          color: "#fff",
          shadow: "0 1px 2px rgba(0, 0, 0, 0.5)",
          separator: "rgba(255, 255, 255, 0.35)",
        };
  }

  // Applied everywhere the banner background is set (creation + registry
  // color updates). Children pick the color up via `color: inherit` and the
  // --wc-* custom properties in style.css.
  function applyBannerContrast(banner, bg) {
    const c = contrastStyleFor(bg);
    banner.style.color = c.color;
    banner.style.setProperty("--wc-text-shadow", c.shadow);
    banner.style.setProperty("--wc-separator", c.separator);
  }

  function currentSymbol() {
    return (
      assignedSymbol ||
      FALLBACK_SYMBOLS[hashInt(getStableKey()) % FALLBACK_SYMBOLS.length]
    );
  }

  // Per-tab JS heap numbers for the memory ranking (aero-tab-memory).
  // CAVEAT: performance.memory is per RENDERER PROCESS, and Chrome can host
  // several same-site tabs (e.g. many app.devin.ai tabs) in one process, so
  // tabs sharing a process report the same heap. Consumers detect that by
  // grouping identical values; we just report what this context sees.
  function memoryInfo() {
    try {
      const m = performance.memory;
      if (!m) return {};
      return {
        jsHeapUsed: m.usedJSHeapSize,
        jsHeapTotal: m.totalJSHeapSize,
        jsHeapLimit: m.jsHeapSizeLimit,
      };
    } catch (e) {
      return {};
    }
  }

  // Ask the background registry for this key's color+symbol; it heartbeats the
  // key so the slot stays reserved. Falls back to hash-derived values until
  // (or if ever) the registry responds. The report payload also carries this
  // tab's determinations so the background can forward them to the local sink
  // (window-colors-sink) for out-of-browser inspection.
  function heartbeat() {
    if (!isDevinSession() && !isCapyThread()) {
      // Non-agent tabs still report a lightweight memory record on the same
      // cadence, so aero-tab-memory can rank EVERY tab, not just Devin/Capy.
      try {
        chrome.runtime.sendMessage({
          type: "memreport",
          report: {
            url: location.href,
            title: document.title,
            ...memoryInfo(),
          },
        }, () => { void chrome.runtime.lastError; });
      } catch (e) {
        // extension context invalidated (reloaded); page reload will fix it
      }
      return;
    }
    const key = getStableKey();
    // Defensive: report building touches the page DOM/storage, which can throw
    // mid-load (null body, sandboxed frames). A failed report must never take
    // down the heartbeat -- the registry slot matters more than the payload.
    let report;
    try {
      // Pre-load Devin/Capy tabs still heartbeat (to hold the color slot) but
      // must not report the bare app name as a session title.
      const devinLoaded = devinSessionLoaded();
      const capyLoaded = capyThreadLoaded();
      report = {
        url: location.href,
        title: document.title,
        kind: isDevinSession() ? "devin" : "capy",
        awaiting: isAwaiting(),
        // Debuggability: how `awaiting` was derived ("sink" = fresh sink
        // summary, "text" = textContent backstop) plus the sink's own view,
        // so a stale-sink/text disagreement is visible in the sink state.
        awaitSource,
        sinkAwaiting: streamSummary ? !!streamSummary.awaiting : null,
        sinkStatusEnumAt: streamSummary
          ? streamSummary.statusEnumAt || null
          : null,
        sinkLastSeen: streamSummary ? streamSummary.lastSeen || null : null,
        hudHidden,
        loaded: isDevinSession() ? devinLoaded : capyLoaded,
        sessionTitle: isDevinSession()
          ? (devinLoaded ? getSessionTitle() : null)
          : (capyLoaded ? getCapyThreadTitle() : null),
        prs: isDevinSession() ? [...collectPRs().entries()] : [],
        color: currentColor(),
        symbol: currentSymbol(),
        ...memoryInfo(),
      };
    } catch (e) {
      report = { url: location.href, reportError: String(e), ...memoryInfo() };
    }
    try {
      chrome.runtime.sendMessage({ type: "heartbeat", key, report }, (resp) => {
        if (chrome.runtime.lastError) return; // extension reloading
        if (resp && resp.color) {
          assignedColor = resp.color;
          assignedSymbol = resp.symbol || null;
          const badge = document.getElementById("wc-badge");
          if (badge) {
            badge.style.backgroundColor = assignedColor;
            badge.textContent = currentSymbol();
          }
          const banner = document.getElementById("wc-banner");
          if (banner) {
            banner.style.backgroundColor = assignedColor;
            applyBannerContrast(banner, assignedColor);
          }
        }
      });
    } catch (e) {
      // extension context invalidated (reloaded); page reload will fix it
    }
  }

  // ── Small corner badge (non-Devin pages) ─────────────────────────────────

  function createBadge() {
    const existing = document.getElementById("wc-badge");
    if (existing) existing.remove();

    const key = getStableKey();
    const badge = document.createElement("div");
    badge.id = "wc-badge";
    badge.style.backgroundColor = currentColor();
    badge.textContent = currentSymbol();
    badge.title = key.substring(0, 20);
    document.body.appendChild(badge);
  }

  // ── Devin session banner (full top row) ──────────────────────────────────
  // Shows the session title big, this session's OPEN PRs (sourced from the
  // devin-stream sink summary -- the captured Devin API is the only reliable
  // PR-state source), and the tail of the chat transcript.

  function getSessionTitle() {
    // The tab title is the session title (Devin sets it); strip any suffix.
    let t = document.title || "";
    t = t.replace(/\s*[-|·]\s*Devin.*$/i, "").trim();
    return t || "(untitled session)";
  }

  const MAX_PRS = 10;

  // ── devin-stream summary (via the background worker) ─────────────────────
  // The devin-stream sink (:48292) aggregates the captured Devin API traffic
  // into a per-session summary: authoritative PR states plus the last
  // human/agent chat messages. Content scripts can't reliably fetch localhost
  // from an https page (private-network-access preflights), so the background
  // worker fetches and caches it; we ask for our session's slice on the
  // heartbeat cadence.
  let streamSummary = null;

  function refreshStreamSummary() {
    if (!isDevinSession()) return;
    try {
      chrome.runtime.sendMessage(
        { type: "stream-summary", sessionId: getStableKey() },
        (resp) => {
          if (chrome.runtime.lastError || !resp) return; // extension reloading
          if (resp.ok) {
            streamSummary = resp.summary || null;
            tick();
          }
        }
      );
    } catch (e) {
      // extension context invalidated; keep the last cached summary
    }
  }

  // Strict open-only predicate, applied identically to both PR sources:
  // include ONLY records verifiably open (state literally "open", not merged,
  // not draft). Unknown/missing state fails closed (excluded).
  function isOpenPr(rec) {
    return !!rec && rec.state === "open" && !rec.merged && !rec.draft;
  }

  // This session's localStorage tab snapshot (`session-tabs:devin-<id>`),
  // as href -> record. NOTE these records are written when the PR tab is
  // OPENED and never refreshed, so their `state` can be stale (a merged PR
  // can still read state:"open" here) -- verified against the captured API
  // data. Useful for titles; NOT trustworthy for state on its own.
  function localTabPRs() {
    const out = new Map();
    try {
      const sid = (location.href.match(
        /app\.devin\.ai\/sessions\/([a-f0-9-]+)/) || [])[1];
      if (!sid) return out;
      const raw = localStorage.getItem(`session-tabs:devin-${sid}`);
      if (!raw) return out;
      for (const tab of JSON.parse(raw).tabs || []) {
        if (tab.type !== "pr" || !tab.data) continue;
        const d = tab.data;
        const href = d.html_url ||
          `https://github.com/${d.owner}/${d.repo}/pull/${d.pull_number}`;
        out.set(href, d);
      }
    } catch (e) {
      // malformed storage entry; treat as no local records
    }
    return out;
  }

  function collectPRs() {
    // Open PRs for this session, href -> label. PR existence and state come
    // SOLELY from the devin-stream sink summary (captured Devin API:
    // v2sessions / /sessions/<id>/prs carry authoritative open|merged|closed).
    // localStorage is used ONLY to supply nicer titles for those PRs -- never
    // to decide which PRs exist or whether they're open, because those records
    // are written when a PR tab is opened and never refreshed, so a merged PR
    // still reads state:"open" there. If this session isn't in the summary
    // (not captured yet, or sink unreachable), render NO PRs -- failing closed
    // beats showing merged PRs as open, which is what the old localStorage
    // fallback did for uncovered sessions.
    const prs = new Map();
    if (!streamSummary || !Array.isArray(streamSummary.prs)) return prs;

    const local = localTabPRs();
    for (const pr of streamSummary.prs) {
      if (prs.size >= MAX_PRS) break;
      if (!isOpenPr(pr) || !pr.url) continue;
      const d = local.get(pr.url);
      const label = (d && d.title) || pr.title ||
        (pr.number ? `#${pr.number}` : pr.url);
      prs.set(pr.url, String(label).trim());
    }
    return prs;
  }

  let lastBannerState = "";

  // ── Message-row link rendering ────────────────────────────────────────────
  // Chat messages often carry long URLs that would render as dead strings.
  // Rows are built from text nodes + real <a> elements (never innerHTML with
  // unsanitized input), with a very short label per link.

  const MSG_URL_RE = /https?:\/\/[^\s<>"')\]]+/g;
  const MSG_LINK_LABEL_MAX = 15;

  function msgLinkLabel(href) {
    const pr = href.match(/github\.com\/[^/]+\/[^/]+\/pull\/(\d+)/);
    if (pr) return "#" + pr[1];
    let label;
    try {
      label = new URL(href).hostname.replace(/^www\./, "");
    } catch {
      label = href.replace(/^https?:\/\//, "");
    }
    return label.length > MSG_LINK_LABEL_MAX
      ? label.slice(0, MSG_LINK_LABEL_MAX) + "…"
      : label;
  }

  function renderMsgText(row, text) {
    let last = 0;
    for (const m of text.matchAll(MSG_URL_RE)) {
      if (m.index > last) {
        row.appendChild(document.createTextNode(text.slice(last, m.index)));
      }
      const a = document.createElement("a");
      a.href = m[0];
      a.textContent = msgLinkLabel(m[0]);
      a.target = "_blank";
      a.rel = "noopener";
      row.appendChild(a);
      last = m.index + m[0].length;
    }
    if (last < text.length) {
      row.appendChild(document.createTextNode(text.slice(last)));
    }
  }

  // The banner's chat rows: the last 6 back-and-forth messages (oldest ->
  // newest, as the conversation happened) from the sink's recentMessages,
  // falling back to the older two-field summary shape when absent.
  const MAX_MSGS = 6;

  function bannerMessages() {
    if (!streamSummary) return [];
    if (Array.isArray(streamSummary.recentMessages) &&
        streamSummary.recentMessages.length) {
      return streamSummary.recentMessages
        .filter((m) => m && m.text)
        .slice(-MAX_MSGS)
        .map((m) => [m.role === "human" ? "👤" : "🤖", m.text]);
    }
    const out = [];
    if (streamSummary.lastHumanMessage)
      out.push(["👤", streamSummary.lastHumanMessage]);
    if (streamSummary.lastAgentMessage)
      out.push(["🤖", streamSummary.lastAgentMessage]);
    return out;
  }

  // Adaptive per-row line budget, heavily top-heavy (13-line total budget):
  // the NEWEST message gets 10 lines, the second-newest 3, and anything
  // older collapses to a single-line context crumb. With two long messages
  // the crumbs' 1-liners are what you see beyond the [10,3] pair; short
  // messages simply don't fill their clamps, so more of the (up to 6) rows
  // fit visually. Array is NEWEST-FIRST; rows still render oldest -> newest
  // like a transcript, so row idx maps to alloc[count - 1 - idx].
  const MSG_LINE_ALLOC = [7, 3, 1, 1, 1, 1];

  function msgLineClamp(idx, count) {
    return MSG_LINE_ALLOC[count - 1 - idx] || 1;
  }

  // ── Banner status line ────────────────────────────────────────────────────
  // "What Devin is doing right now": the sink's statusMessage (the human text
  // Devin shows at the bottom of its page, e.g. "Devin is thinking..."),
  // falling back to the coarser statusEnum ("working") or lifecycle status
  // ("running") when no message was captured. Rendered as a small dimmed row
  // just above the reply input.
  function bannerStatus() {
    if (!streamSummary) return null;
    const t = streamSummary.statusMessage || streamSummary.statusEnum ||
      streamSummary.status;
    return t ? String(t).trim() : null;
  }

  // Session cost, from the sink's captured billing data
  // (/api/billing/usage/session/<id> -> summary costUsd / acuUsed). Dollar
  // figure preferred; ACU shown only if a plan ever bills ACUs without a
  // dollar amount. Null (render nothing) when the session has no captured
  // billing request -- billing only flows for tabs that captured one.
  function bannerCost() {
    if (!streamSummary) return null;
    if (typeof streamSummary.costUsd === "number") {
      return "$" + streamSummary.costUsd.toFixed(2);
    }
    if (typeof streamSummary.acuUsed === "number") {
      return streamSummary.acuUsed + " ACU";
    }
    return null;
  }

  // Create-or-update the status row IN PLACE on an existing banner. Called
  // unconditionally from updateBanner before the rebuild guards, so the
  // status stays live even while a rebuild is deferred (reply input focused
  // or holding a draft) -- same in-place philosophy as applyMsgExpansion.
  function patchStatusRow(banner, text, awaiting) {
    let row = banner.querySelector("#wc-banner-status");
    if (!text) {
      if (row) row.remove();
      return;
    }
    if (!row) {
      row = document.createElement("div");
      row.id = "wc-banner-status";
      row.style.flex = "0 0 auto"; // banner is a flex column; never shrink
      const dot = document.createElement("span");
      dot.id = "wc-banner-status-dot";
      dot.textContent = "●";
      const txt = document.createElement("span");
      txt.id = "wc-banner-status-text";
      row.appendChild(dot);
      row.appendChild(txt);
      // Sits above the reply input (the banner's last child).
      const reply = banner.querySelector("#wc-banner-reply");
      banner.insertBefore(row, reply || null);
    }
    row.classList.toggle("wc-status-awaiting", !!awaiting);
    const txtEl = row.querySelector("#wc-banner-status-text");
    if (txtEl.textContent !== text) txtEl.textContent = text;
  }

  // ── Banner reply input ────────────────────────────────────────────────────
  // A single-line input at the bottom of the banner that forwards text into
  // the page's real chat input (Devin's main textarea/contenteditable) and
  // submits it, as if typed there. The <input> NODE is created exactly once
  // and re-attached to every rebuilt banner so in-progress text survives the
  // 15s re-render; on top of that, updateBanner() defers the rebuild entirely
  // while the input is focused or non-empty, so focus is never yanked away
  // mid-typing (re-attaching a node loses focus even though value survives).
  let replyInput = null;

  function getReplyInput() {
    if (replyInput) return replyInput;
    replyInput = document.createElement("input");
    replyInput.id = "wc-banner-reply";
    replyInput.type = "text";
    replyInput.placeholder = "reply to Devin…";
    replyInput.autocomplete = "off";
    replyInput.spellcheck = false;
    // Banner is a flex column with a viewport max-height; the input must
    // stay reachable, so it never shrinks (only the message list does).
    replyInput.style.flex = "0 0 auto";
    replyInput.addEventListener("keydown", (e) => {
      // Keep banner keystrokes away from the page's global hotkey handlers.
      e.stopPropagation();
      if (e.key === "Enter") {
        const text = replyInput.value.trim();
        if (text) sendReply(text);
      } else if (e.key === "Escape") {
        replyInput.blur();
      }
    });
    replyInput.addEventListener("keyup", (e) => e.stopPropagation());
    replyInput.addEventListener("keypress", (e) => e.stopPropagation());
    return replyInput;
  }

  function flashReplyError(msg) {
    if (!replyInput) return;
    replyInput.classList.add("wc-reply-error");
    replyInput.title = msg;
    setTimeout(() => {
      if (!replyInput) return;
      replyInput.classList.remove("wc-reply-error");
      replyInput.title = "";
    }, 2500);
  }

  // Locate the page's real chat input. Devin renders either a <textarea> or a
  // contenteditable region; inspect defensively: gather every plausible
  // editable element, drop invisible ones and our own HUD, then prefer (a) a
  // placeholder/aria-label that smells like the chat box and (b) the one
  // lowest on the screen (the composer sits under the transcript).
  function findDevinChatInput() {
    const nodes = document.querySelectorAll(
      'textarea, [contenteditable="true"], [role="textbox"]');
    let best = null;
    let bestScore = -Infinity;
    for (const el of nodes) {
      if (el.closest("#wc-banner") || el.closest("#wc-debug-panel")) continue;
      if (el.disabled || el.readOnly) continue;
      const r = el.getBoundingClientRect();
      if (r.width < 80 || r.height < 14) continue;
      if (r.bottom <= 0 || r.top >= window.innerHeight) continue;
      const cs = getComputedStyle(el);
      if (cs.visibility === "hidden" || cs.display === "none") continue;
      const hint = (
        (el.getAttribute("placeholder") || "") + " " +
        (el.getAttribute("aria-label") || "") + " " +
        (el.getAttribute("data-placeholder") || "")
      ).toLowerCase();
      let score = 0;
      if (/devin|ask|reply|message|follow.?up|chat/.test(hint)) score += 10000;
      score += r.top; // lower on the page wins (composer sits at the bottom)
      score += Math.min(r.width, 800) / 100; // wider inputs are likelier
      if (score > bestScore) {
        bestScore = score;
        best = el;
      }
    }
    return best;
  }

  function chatInputValue(el) {
    return el.tagName === "TEXTAREA" || el.tagName === "INPUT"
      ? el.value
      : el.textContent || "";
  }

  // React-controlled inputs ignore plain .value writes (React compares
  // against its own tracked value), so go through the NATIVE prototype value
  // setter and then dispatch a bubbling "input" event -- that is exactly what
  // React's onChange delegation listens for. Contenteditable gets textContent
  // + a bubbling InputEvent instead.
  function setChatInputValue(el, text) {
    el.focus();
    if (el.tagName === "TEXTAREA" || el.tagName === "INPUT") {
      const proto = el.tagName === "TEXTAREA"
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(proto, "value").set.call(el, text);
      el.dispatchEvent(new Event("input", { bubbles: true }));
    } else {
      el.textContent = text;
      el.dispatchEvent(new InputEvent("input", {
        bubbles: true,
        inputType: "insertText",
        data: text,
      }));
    }
  }

  // Send-button fallback: walk up from the chat input looking for a nearby
  // button that is labelled send/submit (aria-label, text, or type=submit).
  function findSendButton(inputEl) {
    let scope = inputEl;
    for (let depth = 0; depth < 6 && scope; depth++, scope = scope.parentElement) {
      for (const b of scope.querySelectorAll('button, [role="button"]')) {
        if (b.closest("#wc-banner")) continue;
        const label = ((b.getAttribute("aria-label") || "") + " " +
          (b.textContent || "")).toLowerCase();
        if (/send|submit/.test(label)) return b;
        if ((b.getAttribute("type") || "").toLowerCase() === "submit") return b;
      }
    }
    return null;
  }

  function sendReply(text) {
    const target = findDevinChatInput();
    if (!target) {
      flashReplyError("Devin chat input not found on this page yet");
      return;
    }
    try {
      setChatInputValue(target, text);
      // Submit path 1: a synthetic Enter on the chat input (content-script
      // events are real DOM events; React key handlers normally fire on them).
      const key = (type) => new KeyboardEvent(type, {
        key: "Enter",
        code: "Enter",
        keyCode: 13,
        which: 13,
        bubbles: true,
        cancelable: true,
      });
      target.dispatchEvent(key("keydown"));
      target.dispatchEvent(key("keyup"));
      // Submit path 2: if the composer still holds the text a beat later the
      // Enter didn't take -- click the send button next to the input instead.
      setTimeout(() => {
        if (chatInputValue(target).trim() === "") return; // Enter worked
        const btn = findSendButton(target);
        if (btn) btn.click();
      }, 200);
      replyInput.value = "";
      replyInput.focus();
    } catch (e) {
      flashReplyError("Send failed: " + e);
    }
  }

  function toggleDebugPanel() {
    const existing = document.getElementById("wc-debug-panel");
    if (existing) {
      existing.remove();
      return;
    }
    const panel = document.createElement("div");
    panel.id = "wc-debug-panel";
    const close = document.createElement("div");
    close.id = "wc-debug-close";
    close.textContent = "✕";
    close.addEventListener("click", () => panel.remove());
    const pre = document.createElement("pre");
    const data = {
      sessionKey: getStableKey(),
      tabReport: {
        loaded: isDevinSession() ? devinSessionLoaded() : capyThreadLoaded(),
        awaiting: isAwaiting(),
        awaitSource,
        sinkAwaitingFresh: sinkAwaitingFresh(),
        color: currentColor(),
        symbol: currentSymbol(),
        ...memoryInfo(),
      },
      sinkSummary: streamSummary,
    };
    pre.textContent = JSON.stringify(data, null, 2);
    panel.appendChild(close);
    panel.appendChild(pre);
    document.documentElement.appendChild(panel);
  }

  // Apply the click-to-expand state to a banner's message rows: the expanded
  // row gets .wc-msg-expanded (clamp removed, scrollable), and the banner
  // gets .wc-msg-expanded-mode, which CSS uses to hide the OTHER rows and
  // the PR row so the message gets the whole content area. Called both at
  // build time (updateBanner) and in place from row click handlers.
  function applyMsgExpansion(banner) {
    banner = banner || document.getElementById("wc-banner");
    if (!banner) return;
    const rows = banner.querySelectorAll(".wc-banner-msg");
    const expandedMode = expandedMsgIdx >= 0 && expandedMsgIdx < rows.length;
    banner.classList.toggle("wc-msg-expanded-mode", expandedMode);
    // Single scrollbar either way (inline, beats stale stylesheets): the
    // messages container scrolls the clamped transcript normally, but while
    // a row is expanded the ROW scrolls (max-height 40vh + overflow) and the
    // container just sizes it -- otherwise the two scroll regions would
    // double-clip each other.
    const msgs = banner.querySelector("#wc-banner-msgs");
    if (msgs) {
      msgs.style.overflowY = expandedMode ? "hidden" : "auto";
      msgs.style.display = expandedMode ? "flex" : "";
      msgs.style.flexDirection = expandedMode ? "column" : "";
    }
    rows.forEach((row, idx) => {
      const expanded = idx === expandedMsgIdx;
      row.classList.toggle("wc-msg-expanded", expanded);
      // Per-row line budget (set at build time in row.dataset.wcClamp) as an
      // INLINE style so it beats any stale injected stylesheet in long-lived
      // tabs; cleared while expanded so the full text shows.
      row.style.webkitLineClamp = expanded ? "" : (row.dataset.wcClamp || "");
      // Expanded row fills the (now non-scrolling) container and scrolls
      // itself; min-height:0 lets it shrink below the cap in short windows.
      // The max-height is viewport-aware (inline, beats stale stylesheets):
      // 40vh normally, but never more than the viewport minus the banner's
      // fixed rows, so expanding can't push the reply input off-screen.
      row.style.flex = expanded ? "1 1 auto" : "";
      row.style.minHeight = expanded ? "0" : "";
      row.style.maxHeight = expanded
        ? "min(40vh, calc(100vh - 120px))"
        : "";
    });
  }

  function updateBanner() {
    // Prefer the sink's LLM-decided title/symbol; fall back to the tab title
    // (raw session title) and the registry/hash symbol when the sink has no
    // decision (enrichment disabled, sink down, brand-new session).
    const title =
      (streamSummary && streamSummary.decidedTitle) || getSessionTitle();
    const symbol =
      (streamSummary && streamSummary.symbol) || currentSymbol();
    const prs = collectPRs();
    const messages = bannerMessages();
    const statusText = bannerStatus();
    const statusAwaiting = !!(streamSummary && streamSummary.awaiting);
    const costText = bannerCost();
    // The expanded row is an index into `messages`; if the list shrank (or
    // vanished) since it was expanded, drop back to the normal view.
    if (expandedMsgIdx >= messages.length) expandedMsgIdx = -1;
    // Status is appended LAST so the expansion click handler's key-patching
    // regex (anchored at the front) keeps working.
    const state =
      (bannerHidden ? "H|" : "S|") + expandedMsgIdx + "|" +
      symbol + "|" + title + "|" + (costText || "") + "|" +
      [...prs.keys()].join(",") + "|" +
      messages.map((m) => m[0] + m[1]).join("|") + "|" +
      (statusAwaiting ? "A" : "-") + (statusText || "");
    let banner = document.getElementById("wc-banner");
    // The status line updates IN PLACE on every pass (cheap text patch), so
    // it stays near-realtime even when the full rebuild below is skipped
    // (unchanged state) or deferred (reply input focused / holding a draft).
    if (banner) patchStatusRow(banner, statusText, statusAwaiting);
    if (banner && state === lastBannerState) return;
    // Never tear the banner down out from under an in-use reply input: a
    // rebuild would re-attach the same node (value survives) but still steal
    // focus mid-typing. Content changes just wait for the next 15s tick.
    if (banner && replyInput &&
        (document.activeElement === replyInput || replyInput.value !== "")) {
      return;
    }
    lastBannerState = state;
    if (banner) banner.remove();

    banner = document.createElement("div");
    banner.id = "wc-banner";
    // Collapsed state hides the title text / PR / message rows via CSS,
    // leaving just the symbol + the two title-row icons as a small strip.
    banner.classList.toggle("wc-collapsed", bannerHidden);
    banner.style.backgroundColor = currentColor();
    applyBannerContrast(banner, currentColor());
    // Flex column (inline, so it beats stale injected stylesheets): together
    // with the max-height set in syncBannerOffset, only the message list
    // (flex:1 1 auto, min-height:0, overflow-y:auto) shrinks and scrolls
    // when the window is short. Everything else is flex:0 0 auto so the
    // title row (with the ⓘ/▾ toggles) and the reply input never get
    // pushed off the bottom of the viewport.
    banner.style.display = "flex";
    banner.style.flexDirection = "column";
    // Hard clamps (inline for the same stale-stylesheet reason): the banner
    // must never exceed the window width in narrow tiled windows, and the
    // max-width/max-height caps must CLIP anything that still doesn't fit
    // instead of letting it spill over the page. Children wrap/scroll
    // internally (see style.css), so clipping only bites in degenerate cases.
    banner.style.maxWidth = "min(1200px, calc(100vw - 16px))";
    banner.style.overflow = "hidden";

    const titleRow = document.createElement("div");
    titleRow.id = "wc-banner-title";
    titleRow.style.flex = "0 0 auto"; // must never shrink off-screen
    const sym = document.createElement("span");
    sym.id = "wc-banner-symbol";
    sym.textContent = symbol;
    const titleText = document.createElement("span");
    titleText.id = "wc-banner-title-text";
    titleText.textContent = title;
    // Hover shows the raw (wire) title when the LLM rewrote it.
    if (streamSummary && streamSummary.decidedTitle) {
      titleText.title = streamSummary.rawTitle || getSessionTitle();
    }
    titleRow.appendChild(sym);
    titleRow.appendChild(titleText);
    banner.appendChild(titleRow);

    // Session cost (captured billing data), a small dimmed figure sitting
    // next to the ⓘ/collapse icons. Rendered ONLY when the sink has billing
    // data for this session -- no placeholder otherwise.
    if (costText) {
      const cost = document.createElement("span");
      cost.id = "wc-banner-cost";
      cost.textContent = costText;
      cost.title = "Session usage (captured billing data)";
      titleRow.appendChild(cost);
    }

    // Small debug affordance: reveals the raw sink summary + this tab's own
    // report that every determination (awaiting, PRs, title/symbol) is based on.
    const dbg = document.createElement("span");
    dbg.id = "wc-banner-debug";
    dbg.textContent = "ⓘ";
    dbg.title = "Show underlying data";
    dbg.addEventListener("click", (e) => {
      e.stopPropagation();
      toggleDebugPanel();
    });
    titleRow.appendChild(dbg);

    // Per-tab hide toggle: collapse this banner to a minimal strip (and back).
    // Same styling family as the ⓘ icon. Distinct from the global HUD dot.
    const hide = document.createElement("span");
    hide.id = "wc-banner-hide";
    hide.textContent = bannerHidden ? "▸" : "▾";
    hide.title = bannerHidden
      ? "Expand banner (this tab)"
      : "Hide banner (this tab)";
    hide.addEventListener("click", (e) => {
      e.stopPropagation();
      bannerHidden = !bannerHidden;
      updateBanner();
      updateAwaitBorder(); // re-sync the banner offset below the awaiting line
    });
    titleRow.appendChild(hide);

    if (prs.size) {
      const prRow = document.createElement("div");
      prRow.id = "wc-banner-prs";
      prRow.style.flex = "0 0 auto";
      // Height cap inline (beats stale stylesheets): a long PR list scrolls
      // within ~3 rows instead of eating the banner's vertical budget
      // (row = 9px font * 1.2 + 2px gap; keep in sync with style.css).
      prRow.style.maxHeight = "37px";
      prRow.style.overflowY = "auto";
      prRow.style.overflowX = "hidden";
      for (const [href, label] of prs) {
        const a = document.createElement("a");
        a.href = href;
        a.textContent = label;
        a.target = href.includes("github.com") ? "_blank" : "_self";
        a.rel = "noopener";
        // Inline (beats stale injected stylesheets of long-lived tabs):
        // chips stay one line each, but a single very long PR title
        // ellipsizes at 40ch instead of forcing the banner's intrinsic
        // width past the viewport (nowrap text in a flex-wrap row still
        // widens the row by its longest single chip).
        a.style.whiteSpace = "nowrap";
        a.style.maxWidth = "min(40ch, 100%)";
        a.style.overflow = "hidden";
        a.style.textOverflow = "ellipsis";
        prRow.appendChild(a);
      }
      banner.appendChild(prRow);
    }

    // Recent chat messages (from the devin-stream captured-API summary):
    // the last 4 human/agent CHAT messages in conversation order
    // (reasoning/tool events are excluded sink-side). Rendered below the PR
    // list, set off by a separator line.
    if (messages.length) {
      const msgs = document.createElement("div");
      msgs.id = "wc-banner-msgs";
      // The ONE flex child allowed to shrink: when the height cap bites,
      // the transcript scrolls between the (pinned) title row and reply
      // input instead of pushing them off-screen. min-height:0 lets a flex
      // item actually shrink below its content size; pointer-events:auto is
      // needed because the banner root is pointer-events:none and a
      // scrollable container must receive wheel events itself. Inline so it
      // beats stale injected stylesheets in long-lived tabs.
      msgs.style.flex = "1 1 auto";
      msgs.style.minHeight = "0";
      msgs.style.overflowY = "auto";
      msgs.style.pointerEvents = "auto";
      messages.forEach(([icon, text], idx) => {
        const row = document.createElement("div");
        row.className = "wc-banner-msg";
        row.title = "Click to expand/collapse this message";
        // 15-line budget across rows, biggest clamp on the newest message;
        // applyMsgExpansion applies it inline (and lifts it while expanded).
        row.dataset.wcClamp = String(msgLineClamp(idx, messages.length));
        renderMsgText(row, icon + " " + text);
        row.addEventListener("click", (e) => {
          // Links inside rows must still navigate, not toggle expansion.
          if (e.target && e.target.closest && e.target.closest("a")) return;
          e.stopPropagation();
          expandedMsgIdx = expandedMsgIdx === idx ? -1 : idx;
          applyMsgExpansion();
          // Keep the render-state key in sync so the next 15s tick doesn't
          // see a "changed" state and rebuild the banner just for this (a
          // rebuild would also be skipped while the reply input holds text,
          // which is exactly why expansion is applied in place).
          lastBannerState = lastBannerState.replace(
            /^([HS]\|)-?\d+\|/, "$1" + expandedMsgIdx + "|");
        });
        msgs.appendChild(row);
      });
      banner.appendChild(msgs);
    }
    applyMsgExpansion(banner);

    // Reply input: always the SAME node (see getReplyInput), re-attached to
    // each rebuilt banner so any typed-but-unsent text is never discarded.
    banner.appendChild(getReplyInput());

    // Status line ("what Devin is doing right now"), just above the reply
    // input. patchStatusRow inserts before #wc-banner-reply, so the input
    // must already be attached.
    patchStatusRow(banner, statusText, statusAwaiting);

    document.documentElement.appendChild(banner);
    // Fresh banner nodes start at top:0; push it below the awaiting line if
    // one is currently showing.
    syncBannerOffset();
  }

  // ── "Awaiting instructions" border ──────────────────────────────────────
  // Chats where the agent has stopped and needs the user get a highlighted
  // border.
  //
  // Devin sessions: the awaiting flag comes from the devin-stream sink's
  // per-session summary (`awaiting`, derived server-side from the captured
  // Devin API: status "suspended" or a status_update with enum "blocked")
  // -- but ONLY while that status is FRESH. The sink only learns status when
  // some Devin tab's captured traffic happens to include it, so its
  // statusEnumAt can lag the page by an hour+ (observed: sink saying
  // working/"Devin is thinking..." while the page showed "awaiting
  // instructions"). The freshness gate below keeps the common case cheap
  // (fresh sink -> no DOM read at all) and adds a bounded backstop: only for
  // sessions ABSENT from the sink or with a stale/missing statusEnumAt does
  // a single textContent scan run, on the slow render/heartbeat cadence.
  // This is NOT the old always-on multi-MB scanning -- it never uses
  // innerText (forces layout), never installs a MutationObserver, and stops
  // as soon as a fresh sink status arrives (refreshStreamSummary re-fetches
  // on the heartbeat cadence, so a newer statusEnumAt takes over again).
  //
  // Capy (and other) pages have no captured stream, so detection stays
  // text-based there, but cheap: textContent only, on the slow render
  // interval, and skipped entirely when the tab is hidden.
  const AWAIT_PATTERNS = [
    /a?waiting (for )?instructions/i,
    /action required/i,
    /devin went to sleep/i,
    /capy is idle/i,
  ];

  // Sink freshness thresholds. Two independent signals make the sink's
  // awaiting flag authoritative:
  //   1. statusEnumAt (when the status last CHANGED) is recent -- the session
  //      is actively transitioning, so the flag is obviously current.
  //   2. lastSeen (when the sink last OBSERVED this session) is recent -- the
  //      devin-stream active poll (background.js) refetches the org-wide
  //      v2sessions list every ~2.5 min, re-folding status/awaiting for EVERY
  //      session, so a fresh observation means the flag reflects current
  //      server state even for sessions sitting in a stable state (suspended/
  //      finished) whose statusEnumAt is hours old. Without (2), those stable
  //      sessions -- the bulk of open background tabs -- always failed the
  //      freshness gate and fell to the text backstop even though the sink
  //      knew their state; (2) is what lets the active poll actually move tabs
  //      onto awaitSource "sink".
  const AWAIT_SINK_FRESH_MS = 4 * 60 * 1000;
  const AWAIT_SINK_OBSERVED_MS = 6 * 60 * 1000; // > poll period, with margin

  // Parse the sink's timestamps (ISO with a numeric offset like -0700; some
  // engines want the offset colon, so insert it before Date.parse).
  function parseSinkTs(ts) {
    if (!ts) return NaN;
    return Date.parse(String(ts).replace(/([+-]\d{2})(\d{2})$/, "$1:$2"));
  }

  function sinkAwaitingFresh() {
    if (!streamSummary) return false;
    const changed = parseSinkTs(streamSummary.statusEnumAt);
    if (Number.isFinite(changed) && Date.now() - changed <= AWAIT_SINK_FRESH_MS) {
      return true;
    }
    const seen = parseSinkTs(streamSummary.lastSeen);
    return Number.isFinite(seen) && Date.now() - seen <= AWAIT_SINK_OBSERVED_MS;
  }

  let lastTextAwaiting = false;
  // How the last isAwaiting() value was derived: "sink" (fresh sink summary,
  // stable, no hysteresis needed) or "text" (textContent scan, flicker-prone,
  // hysteresis applies). Reported in heartbeats + debug panel.
  let awaitSource = "text";

  function scanTextAwaiting() {
    if (!document.body) return false;
    const full = document.body.textContent || "";
    lastTextAwaiting = AWAIT_PATTERNS.some((p) => p.test(full));
    return lastTextAwaiting;
  }

  function isAwaiting() {
    if (isDevinSession()) {
      if (sinkAwaitingFresh()) {
        awaitSource = "sink";
        return !!streamSummary.awaiting;
      }
      // Stale/absent sink status: the page is ground truth for "right now",
      // so the text backstop wins over the stale sink. Unlike the Capy path
      // below, hidden tabs ARE scanned -- the auto-reclaim policy
      // (background.js) keys off awaiting for BACKGROUND tabs, which is
      // exactly where sink staleness bites. Cost stays bounded: hidden tabs
      // only reach here on the 30s heartbeat cadence (tick() skips them),
      // and only while this session's sink status is stale/missing.
      awaitSource = "text";
      return scanTextAwaiting();
    }
    awaitSource = "text";
    // Hidden tabs keep reporting the last known state instead of paying for
    // a fresh multi-MB textContent allocation nobody can see.
    if (document.hidden) return lastTextAwaiting;
    return scanTextAwaiting();
  }

  // Hysteresis (text-derived detection only): text detection can briefly
  // drop the awaiting phrase while an SPA re-renders, making the border
  // flash. Turn the border on immediately, but only remove it after several
  // consecutive non-awaiting evaluations. The sink-derived flag is stable
  // and skips this; Devin pages that fell back to the text backstop get the
  // same debounce as Capy.
  const AWAIT_OFF_TICKS = 3;
  const AWAIT_LINE_PX = 22;
  let awaitMissCount = 0;
  let lastAwaiting = null; // stabilized state

  // Line visuals, duplicated inline so they win over any stale injected
  // stylesheet: long-lived tabs keep the style.css they loaded with and that
  // copy wins the cascade over re-injected CSS. The gradient is deliberately
  // STATIC (animation:none, explicit to beat stale stylesheets that still
  // carry the old wc-await-sweep animation): dozens of these bars animating
  // across visible windows kept the compositor permanently busy.
  const AWAIT_LINE_BASE_CSS =
    "height:" + AWAIT_LINE_PX + "px;border:0;" +
    "background:linear-gradient(90deg,#ff6a00,#ffd27a,#ff6a00);" +
    "background-size:200% 100%;box-sizing:border-box;pointer-events:none;" +
    "animation:none;";

  // Keep the banner just below the awaiting line: banner top = line height
  // while the line is present, 0 otherwise. Applied INLINE so it wins over
  // stale stylesheets, and re-applied whenever the awaiting state flips
  // (updateAwaitBorder) or the banner is rebuilt (updateBanner) -- the
  // rebuilt node starts without the inline offset. Awaiting is sink-driven
  // and debounced, so flips (and thus layout shifts) are infrequent.
  function syncBannerOffset() {
    const banner = document.getElementById("wc-banner");
    if (!banner) return;
    const topPx = document.getElementById("wc-await-border")
      ? AWAIT_LINE_PX
      : 0;
    const top = topPx + "px";
    if (banner.style.top !== top) banner.style.top = top;
    // Mirror the offset into a viewport height cap so the banner can never
    // run off the bottom of the window (worst case: many PRs + 6 message
    // rows in a short tiled window pushed the collapse toggle and reply
    // input off-screen). calc(100vh - ...) tracks window resizes for free.
    // The banner is a flex column where ONLY the message list shrinks and
    // scrolls (see updateBanner + style.css), so the title row's ⓘ/▾
    // toggles and the reply input always stay reachable.
    const maxH = "calc(100vh - " + (topPx + 8) + "px)";
    if (banner.style.maxHeight !== maxH) banner.style.maxHeight = maxH;
  }

  function updateAwaitBorder() {
    let border = document.getElementById("wc-await-border");
    const raw = isAwaiting();
    awaitMissCount = raw ? 0 : awaitMissCount + 1;
    const awaiting = awaitSource === "sink"
      ? raw // sink-derived: stable, no flicker to smooth over
      : raw || (lastAwaiting === true && awaitMissCount < AWAIT_OFF_TICKS);
    if (lastAwaiting !== null && awaiting !== lastAwaiting) {
      heartbeat(); // push the state flip to the sink promptly
    }
    lastAwaiting = awaiting;
    if (!awaiting) {
      if (border) border.remove();
      syncBannerOffset();
      return;
    }
    // The line is pinned across the very top of the viewport on ALL pages
    // (Devin and Capy alike): with a 2-row tiled window grid the awaiting
    // state must be visible at each window's top edge, which beats the old
    // no-layout-shift preference (banner-bottom attachment). The Devin
    // banner shifts down by the line height while the line is present
    // (syncBannerOffset) so the two never overlap.
    if (border && border.parentNode !== document.documentElement) {
      // An older build parented the line inside the banner; rebuild it.
      border.remove();
      border = null;
    }
    if (!border) {
      border = document.createElement("div");
      border.id = "wc-await-border";
      border.setAttribute("aria-hidden", "true");
      border.style.cssText =
        "position:fixed;left:0;right:0;top:0;bottom:auto;z-index:2147483647;" +
        AWAIT_LINE_BASE_CSS;
      document.documentElement.appendChild(border);
    }
    syncBannerOffset();
  }

  function tick() {
    renderHudToggle();
    if (hudHidden) {
      for (const id of ["wc-badge", "wc-banner", "wc-await-border"]) {
        const el = document.getElementById(id);
        if (el) el.remove();
      }
      return;
    }
    // Badges/banners are for agent chats only (Devin sessions, Capy threads);
    // ordinary Chrome pages get nothing but the awaiting-border detection.
    if (isDevinSession()) {
      const badge = document.getElementById("wc-badge");
      if (badge) badge.remove();
      if (!devinSessionLoaded()) {
        // Still on the login/loading splash: render nothing (no banner, no
        // awaiting line) until the session hydrates. tick() runs on a timer
        // and DOM mutations, so the HUD appears as soon as the title does.
        for (const id of ["wc-banner", "wc-await-border"]) {
          const el = document.getElementById(id);
          if (el) el.remove();
        }
        lastBannerState = "";
        return;
      }
      updateBanner();
    } else if (isCapyThread()) {
      const banner = document.getElementById("wc-banner");
      if (banner) banner.remove();
      if (!capyThreadLoaded()) {
        // Still loading (title is empty or just "Capy"): render nothing
        // until the thread hydrates, mirroring the Devin pre-load gate.
        for (const id of ["wc-badge", "wc-await-border"]) {
          const el = document.getElementById(id);
          if (el) el.remove();
        }
        return;
      }
      if (!document.getElementById("wc-badge")) createBadge();
    } else {
      for (const id of ["wc-badge", "wc-banner"]) {
        const el = document.getElementById(id);
        if (el) el.remove();
      }
    }
    updateAwaitBorder();
  }

  tick();
  heartbeat();
  refreshStreamSummary();

  // No MutationObserver: a childList+subtree observer on a busy Devin SPA
  // fires tick() on every DOM change, and the old text-scanning tick made
  // that a multi-MB allocation + forced layout per mutation burst. The HUD
  // is now driven by a slow timer (which also picks up SPA navigation via
  // the URL/title reads in tick()) plus push events: storage changes and
  // stream-summary responses both call tick() directly.
  const tickTimer = setInterval(() => {
    if (document.hidden) return; // nothing visible to render; scan nothing
    tick();
  }, RENDER_INTERVAL_MS);
  const onVisible = () => {
    if (document.hidden) return;
    tick();
    refreshStreamSummary(); // snap the status line current on tab switch
  };
  document.addEventListener("visibilitychange", onVisible);
  const hbTimer = setInterval(() => {
    heartbeat();
    refreshStreamSummary();
  }, HEARTBEAT_INTERVAL_MS);
  // Fast summary path for the tab the user is LOOKING at: visible Devin tabs
  // re-request the (background-cached) sink summary every 8s so the status
  // line tracks Devin in near-realtime. Hidden tabs skip this entirely and
  // stay on the 30s heartbeat cadence above.
  const fastSummaryTimer = setInterval(() => {
    if (document.hidden || !isDevinSession()) return;
    refreshStreamSummary();
  }, SUMMARY_FAST_INTERVAL_MS);

  window.__wcCleanup = function () {
    clearInterval(tickTimer);
    clearInterval(hbTimer);
    clearInterval(fastSummaryTimer);
    document.removeEventListener("visibilitychange", onVisible);
    try { chrome.storage.onChanged.removeListener(onStorageChanged); } catch (e) {}
    for (const id of ["wc-badge", "wc-banner", "wc-await-border",
                      "wc-hud-toggle", "wc-debug-panel"]) {
      const el = document.getElementById(id);
      if (el) el.remove();
    }
  };
})();
