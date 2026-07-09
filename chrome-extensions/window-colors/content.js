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

  // The banner's chat rows: the last 4 back-and-forth messages (oldest ->
  // newest, as the conversation happened) from the sink's recentMessages,
  // falling back to the older two-field summary shape when absent.
  function bannerMessages() {
    if (!streamSummary) return [];
    if (Array.isArray(streamSummary.recentMessages) &&
        streamSummary.recentMessages.length) {
      return streamSummary.recentMessages
        .filter((m) => m && m.text)
        .slice(-4)
        .map((m) => [m.role === "human" ? "👤" : "🤖", m.text]);
    }
    const out = [];
    if (streamSummary.lastHumanMessage)
      out.push(["👤", streamSummary.lastHumanMessage]);
    if (streamSummary.lastAgentMessage)
      out.push(["🤖", streamSummary.lastAgentMessage]);
    return out;
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
    const state =
      symbol + "|" + title + "|" + [...prs.keys()].join(",") + "|" +
      messages.map((m) => m[0] + m[1]).join("|");
    let banner = document.getElementById("wc-banner");
    if (banner && state === lastBannerState) return;
    lastBannerState = state;
    if (banner) banner.remove();

    banner = document.createElement("div");
    banner.id = "wc-banner";
    banner.style.backgroundColor = currentColor();
    applyBannerContrast(banner, currentColor());

    const titleRow = document.createElement("div");
    titleRow.id = "wc-banner-title";
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

    if (prs.size) {
      const prRow = document.createElement("div");
      prRow.id = "wc-banner-prs";
      for (const [href, label] of prs) {
        const a = document.createElement("a");
        a.href = href;
        a.textContent = label;
        a.target = href.includes("github.com") ? "_blank" : "_self";
        a.rel = "noopener";
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
      for (const [icon, text] of messages) {
        const row = document.createElement("div");
        row.className = "wc-banner-msg";
        renderMsgText(row, icon + " " + text);
        msgs.appendChild(row);
      }
      banner.appendChild(msgs);
    }

    document.documentElement.appendChild(banner);
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

  // Sink status freshness threshold: the sink's awaiting flag is
  // authoritative only while its statusEnumAt is at most this old.
  const AWAIT_SINK_FRESH_MS = 4 * 60 * 1000;

  function sinkAwaitingFresh() {
    if (!streamSummary || !streamSummary.statusEnumAt) return false;
    const t = Date.parse(streamSummary.statusEnumAt);
    return Number.isFinite(t) && Date.now() - t <= AWAIT_SINK_FRESH_MS;
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

  // Shared visuals for both placements. Inline so it wins over any stale
  // injected stylesheet: long-lived tabs keep the style.css they loaded with
  // and that copy wins the cascade over re-injected CSS, so geometry AND
  // animation must be inline too (the @keyframes themselves live in
  // style.css).
  const AWAIT_LINE_BASE_CSS =
    "height:" + AWAIT_LINE_PX + "px;border:0;" +
    "background:linear-gradient(90deg,#ff6a00,#ffd27a,#ff6a00);" +
    "background-size:200% 100%;box-sizing:border-box;pointer-events:none;" +
    "animation:wc-await-sweep 1.8s ease-in-out infinite alternate;";

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
      return;
    }
    // When a banner exists the line attaches to its bottom edge (in-flow last
    // child; negative margins cancel the banner padding so it spans the full
    // banner width). The banner stays fixed at top:0 and never shifts -- it
    // only extends downward while awaiting. Bannerless pages (Capy, other
    // chats) keep the viewport-top line. If the banner was just (re)created
    // or removed, re-parent by rebuilding.
    const banner = document.getElementById("wc-banner");
    const wantParent = banner || document.documentElement;
    if (border && border.parentNode !== wantParent) {
      border.remove();
      border = null;
    }
    if (!border) {
      border = document.createElement("div");
      border.id = "wc-await-border";
      border.setAttribute("aria-hidden", "true");
      border.style.cssText = banner
        ? "position:static;display:block;margin:5px -12px -5px;" +
          AWAIT_LINE_BASE_CSS
        : "position:fixed;left:0;right:0;top:0;bottom:auto;z-index:2147483647;" +
          AWAIT_LINE_BASE_CSS;
      wantParent.appendChild(border);
    }
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
    if (!document.hidden) tick();
  };
  document.addEventListener("visibilitychange", onVisible);
  const hbTimer = setInterval(() => {
    heartbeat();
    refreshStreamSummary();
  }, HEARTBEAT_INTERVAL_MS);

  window.__wcCleanup = function () {
    clearInterval(tickTimer);
    clearInterval(hbTimer);
    document.removeEventListener("visibilitychange", onVisible);
    try { chrome.storage.onChanged.removeListener(onStorageChanged); } catch (e) {}
    for (const id of ["wc-badge", "wc-banner", "wc-await-border",
                      "wc-hud-toggle", "wc-debug-panel"]) {
      const el = document.getElementById(id);
      if (el) el.remove();
    }
  };
})();
