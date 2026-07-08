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
      report = {
        url: location.href,
        title: document.title,
        kind: isDevinSession() ? "devin" : "capy",
        awaiting: isAwaiting(),
        sessionTitle: isDevinSession() ? getSessionTitle() : null,
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
  // Shows the session title big, plus a running list of the PRs found on the
  // page. PRs come from real GitHub anchors when present, otherwise from
  // Devin's "pr:NNNN" tab chips (linked back to the session's PR tab).

  function getSessionTitle() {
    // The tab title is the session title (Devin sets it); strip any suffix.
    let t = document.title || "";
    t = t.replace(/\s*[-|·]\s*Devin.*$/i, "").trim();
    return t || "(untitled session)";
  }

  const MAX_PRS = 10;

  function collectPRs() {
    // Devin keeps this session's open tabs (including full PR metadata) in
    // localStorage under `session-tabs:devin-<sessionId>` -- no DOM scraping
    // needed. Only open, unmerged PRs are shown.
    const prs = new Map(); // href -> label
    try {
      const sid = (location.href.match(
        /app\.devin\.ai\/sessions\/([a-f0-9-]+)/) || [])[1];
      if (!sid) return prs;
      const raw = localStorage.getItem(`session-tabs:devin-${sid}`);
      if (!raw) return prs;
      for (const tab of JSON.parse(raw).tabs || []) {
        if (prs.size >= MAX_PRS) break;
        if (tab.type !== "pr" || !tab.data) continue;
        const d = tab.data;
        if (d.state !== "open" || d.merged) continue;
        const href = d.html_url ||
          `https://github.com/${d.owner}/${d.repo}/pull/${d.pull_number}`;
        const label = (d.title || `${d.repo}#${d.pull_number}`).trim();
        prs.set(href, label);
      }
    } catch (e) {
      // malformed storage entry; show no PRs rather than wrong ones
    }
    return prs;
  }

  let lastBannerState = "";

  function updateBanner() {
    const title = getSessionTitle();
    const prs = collectPRs();
    const state = title + "|" + [...prs.keys()].join(",");
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

    document.documentElement.appendChild(banner);
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
  let awaitMissCount = 0;
  let lastAwaiting = null; // stabilized state

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
        // Inline so it wins over any stale injected stylesheet that still
        // carries the old pulse animation.
        border.style.animation = "none";
        document.documentElement.appendChild(border);
      }
    } else if (border) {
      border.remove();
    }
  }

  function tick() {
    // Badges/banners are for agent chats only (Devin sessions, Capy threads);
    // ordinary Chrome pages get nothing but the awaiting-border detection.
    if (isDevinSession()) {
      const badge = document.getElementById("wc-badge");
      if (badge) badge.remove();
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

  // SPA content updates in place, so re-evaluate on DOM changes and a timer.
  const observer = new MutationObserver(tick);
  if (document.body) {
    observer.observe(document.body, { childList: true, subtree: true });
  }
  const tickTimer = setInterval(tick, 2000);
  const hbTimer = setInterval(heartbeat, 30000);

  window.__wcCleanup = function () {
    observer.disconnect();
    clearInterval(tickTimer);
    clearInterval(hbTimer);
    for (const id of ["wc-badge", "wc-banner", "wc-await-border"]) {
      const el = document.getElementById(id);
      if (el) el.remove();
    }
  };
})();
