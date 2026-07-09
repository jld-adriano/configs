(function () {
  // Guard: the background worker re-injects this script into open tabs on
  // extension (re)load, so tear down any previous instance first.
  if (window.__wcCleanup) {
    try { window.__wcCleanup(); } catch (e) {}
  }

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

  const FALLBACK_SYMBOLS = [
    "⚔️", "🛡️", "🐉", "🔥", "⚡", "🌊", "🎯", "🚀", "🧭", "⚓",
    "🎲", "🗝️", "💎", "🪐", "🌵", "🍄", "🦊", "🐙", "🦅", "🐢",
    "🐝", "🌙", "☀️", "⭐", "🌈", "🍉", "🍕", "⚙️", "🧲", "🔮",
    "🦖", "🏰", "🔔", "🍀", "🥁", "🪁", "🎈", "🧊", "🌋", "🛸",
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
      // Pre-load Devin tabs still heartbeat (to hold the color slot) but must
      // not report the bare app name as a session title.
      const devinLoaded = devinSessionLoaded();
      report = {
        url: location.href,
        title: document.title,
        kind: isDevinSession() ? "devin" : "capy",
        awaiting: isAwaiting(),
        hudHidden,
        loaded: isDevinSession() ? devinLoaded : true,
        sessionTitle: isDevinSession() && devinLoaded ? getSessionTitle() : null,
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
          if (banner) banner.style.backgroundColor = assignedColor;
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
  // True once the background confirmed the sink is reachable (even if it has
  // no entry for this session). Until then PR rendering fails closed: the
  // localStorage fallback alone cannot distinguish open from merged.
  let streamSummaryAnswered = false;

  function refreshStreamSummary() {
    if (!isDevinSession()) return;
    try {
      chrome.runtime.sendMessage(
        { type: "stream-summary", sessionId: getStableKey() },
        (resp) => {
          if (chrome.runtime.lastError || !resp) return; // extension reloading
          if (resp.ok) {
            streamSummary = resp.summary || null;
            streamSummaryAnswered = true;
            tick();
          }
        }
      );
    } catch (e) {
      // extension context invalidated; keep the last cached summary
    }
  }

  // Authoritative PR state by URL, from the captured Devin API data. Returns
  // "open" | "merged" | "closed" | null (unknown).
  function streamPrState(href) {
    if (!streamSummary || !Array.isArray(streamSummary.prs)) return null;
    for (const pr of streamSummary.prs) {
      if (pr.url === href) {
        if (pr.merged) return "merged";
        return pr.state || null;
      }
    }
    return null;
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
    // Open PRs for this session, href -> label. Source of truth is the
    // devin-stream summary (live Devin API captures: v2sessions /
    // /sessions/<id>/prs carry authoritative state open|merged|closed).
    // localStorage records only fill in titles, or act as the fallback
    // source when the sink knows nothing about this session. Until the sink
    // has answered at least once, render NO PRs (fail closed): the local
    // records alone cannot distinguish open from merged, and briefly showing
    // nothing beats confidently showing merged PRs as open.
    const prs = new Map();
    const local = localTabPRs();

    if (streamSummary && Array.isArray(streamSummary.prs) &&
        streamSummary.prs.length) {
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

    if (!streamSummaryAnswered) return prs;

    for (const [href, d] of local) {
      if (prs.size >= MAX_PRS) break;
      if (!isOpenPr(d)) continue;
      const apiState = streamPrState(href);
      if (apiState !== null && apiState !== "open") continue; // stale record
      const label = (d.title || `${d.repo}#${d.pull_number}`).trim();
      prs.set(href, label);
    }
    return prs;
  }

  let lastBannerState = "";

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

  function updateBanner() {
    const title = getSessionTitle();
    const prs = collectPRs();
    const messages = bannerMessages();
    const state =
      title + "|" + [...prs.keys()].join(",") + "|" +
      messages.map((m) => m[0] + m[1]).join("|");
    let banner = document.getElementById("wc-banner");
    if (banner && state === lastBannerState) return;
    lastBannerState = state;
    if (banner) banner.remove();

    banner = document.createElement("div");
    banner.id = "wc-banner";
    banner.style.backgroundColor = currentColor();

    const titleRow = document.createElement("div");
    titleRow.id = "wc-banner-title";
    const sym = document.createElement("span");
    sym.id = "wc-banner-symbol";
    sym.textContent = currentSymbol();
    const titleText = document.createElement("span");
    titleText.textContent = title;
    titleRow.appendChild(sym);
    titleRow.appendChild(titleText);
    banner.appendChild(titleRow);

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
        row.textContent = icon + " " + text;
        msgs.appendChild(row);
      }
      banner.appendChild(msgs);
    }

    document.documentElement.appendChild(banner);
    syncBannerOffset();
  }

  // ── "Awaiting instructions" border ──────────────────────────────────────
  // Chats where the agent has stopped and needs the user get a highlighted
  // border. Detection is text-based (the phrases the agent apps render), so
  // it works uniformly for Devin/Capy/Slack/etc.
  const AWAIT_PATTERNS = [
    /a?waiting (for )?instructions/i,
    /action required/i,
    /devin went to sleep/i,
    /capy is idle/i,
  ];

  function isAwaiting() {
    if (!document.body) return false;
    // Check BOTH innerText and textContent: innerText excludes text hidden via
    // visibility/display (Devin blinks its status element with a CSS
    // animation, so innerText samples flicker), while textContent includes
    // hidden text. textContent may also match hidden templates/tooltips --
    // acceptable, since the phrase list is specific.
    const rendered = document.body.innerText || "";
    const full = document.body.textContent || "";
    return AWAIT_PATTERNS.some((p) => p.test(rendered) || p.test(full));
  }

  // Hysteresis: isAwaiting() reads document.body.innerText, which can briefly
  // drop the awaiting phrase while the SPA re-renders, making the border flash.
  // Turn the border on immediately, but only remove it after several
  // consecutive non-awaiting evaluations.
  const AWAIT_OFF_TICKS = 3;
  const AWAIT_LINE_PX = 32;
  let awaitMissCount = 0;
  let lastAwaiting = null; // stabilized state

  // The awaiting line sits ABOVE the banner (both fixed at the top), so when
  // it's visible the banner shifts down by the line's height.
  function syncBannerOffset() {
    const banner = document.getElementById("wc-banner");
    if (!banner) return;
    const line = document.getElementById("wc-await-border");
    banner.style.top = line ? AWAIT_LINE_PX + "px" : "0px";
  }

  function updateAwaitBorder() {
    let border = document.getElementById("wc-await-border");
    const raw = isAwaiting();
    awaitMissCount = raw ? 0 : awaitMissCount + 1;
    const awaiting =
      raw || (lastAwaiting === true && awaitMissCount < AWAIT_OFF_TICKS);
    if (lastAwaiting !== null && awaiting !== lastAwaiting) {
      heartbeat(); // push the state flip to the sink promptly
    }
    lastAwaiting = awaiting;
    if (awaiting) {
      if (!border) {
        border = document.createElement("div");
        border.id = "wc-await-border";
        border.setAttribute("aria-hidden", "true");
        // Inline so it wins over any stale injected stylesheet: long-lived
        // tabs keep the style.css they loaded with (old pulse animation, old
        // bottom-line geometry) and that copy wins the cascade over
        // re-injected CSS, so geometry AND animation must be inline too (the
        // @keyframes themselves live in style.css).
        border.style.cssText =
          "position:fixed;left:0;right:0;top:0;bottom:auto;" +
          "height:" + AWAIT_LINE_PX + "px;border:0;" +
          "background:linear-gradient(90deg,#ff6a00,#ffd27a,#ff6a00);" +
          "background-size:200% 100%;box-sizing:border-box;" +
          "z-index:2147483647;pointer-events:none;" +
          "animation:wc-await-sweep 1.8s ease-in-out infinite alternate;";
        document.documentElement.appendChild(border);
      }
    } else if (border) {
      border.remove();
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
        syncBannerOffset();
        return;
      }
      updateBanner();
    } else if (isCapyThread()) {
      const banner = document.getElementById("wc-banner");
      if (banner) banner.remove();
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

  // SPA content updates in place, so re-evaluate on DOM changes and a timer.
  const observer = new MutationObserver(tick);
  if (document.body) {
    observer.observe(document.body, { childList: true, subtree: true });
  }
  const tickTimer = setInterval(tick, 2000);
  const hbTimer = setInterval(() => {
    heartbeat();
    refreshStreamSummary();
  }, 30000);

  window.__wcCleanup = function () {
    observer.disconnect();
    clearInterval(tickTimer);
    clearInterval(hbTimer);
    try { chrome.storage.onChanged.removeListener(onStorageChanged); } catch (e) {}
    for (const id of ["wc-badge", "wc-banner", "wc-await-border", "wc-hud-toggle"]) {
      const el = document.getElementById(id);
      if (el) el.remove();
    }
  };
})();
