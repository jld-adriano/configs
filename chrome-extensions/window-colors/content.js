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

  // Ask the background registry for this key's color+symbol; it heartbeats the
  // key so the slot stays reserved. Falls back to hash-derived values until
  // (or if ever) the registry responds. The report payload also carries this
  // tab's determinations so the background can forward them to the local sink
  // (window-colors-sink) for out-of-browser inspection.
  function heartbeat() {
    if (!isDevinSession() && !isCapyThread()) return;
    const key = getStableKey();
    const report = {
      url: location.href,
      kind: isDevinSession() ? "devin" : "capy",
      awaiting: isAwaiting(),
      sessionTitle: isDevinSession() ? getSessionTitle() : null,
      prs: isDevinSession() ? [...collectPRs().entries()] : [],
      prsDebug: isDevinSession() ? collectPRsDebug() : [],
      color: currentColor(),
      symbol: currentSymbol(),
    };
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
  const TOP_BAR_PX = 160; // only trust elements in the session's top tab bar

  function inTopBar(el) {
    const r = el.getBoundingClientRect();
    return r.top >= 0 && r.top < TOP_BAR_PX && r.height > 0 && r.height < 80;
  }

  function collectPRs() {
    // Only the current session's top tab bar counts: the sidebar/session list
    // also renders "pr:NNNN" chips for OTHER sessions, so a whole-page scan
    // would pick up hundreds of them.
    const prs = new Map(); // href -> label
    for (const a of document.querySelectorAll('a[href*="github.com"]')) {
      if (prs.size >= MAX_PRS) break;
      const m = (a.href || "").match(
        /github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/);
      if (!m || !inTopBar(a)) continue;
      // Prefer the PR title: use the anchor's own text when it reads like a
      // title rather than a bare URL/number reference.
      const text = (a.textContent || "").trim().replace(/\s+/g, " ");
      const looksLikeTitle =
        text.length > 8 && !/^https?:\/\//.test(text) &&
        !/^#?\d+$/.test(text) && !/^pr[:#]?\s?\d+$/i.test(text);
      prs.set(m[0], looksLikeTitle ? text : `${m[2]}#${m[3]}`);
    }
    // Devin's tab chips render as "pr:104487" text without hrefs; link those
    // to the session's own PR tab so they're still one click away.
    const seen = new Set([...prs.values()].map((l) => l.split("#")[1]));
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode()) && prs.size < MAX_PRS) {
      const t = (node.textContent || "").trim();
      const m = t.match(/^pr:\s?#?(\d{3,7})$/i); // exact chip text only
      if (!m) continue;
      const el = node.parentElement;
      if (!el || !inTopBar(el)) continue;
      const n = m[1];
      if (seen.has(n)) continue;
      seen.add(n);
      // Chips carry no PR title in their text; check nearby tooltip attrs
      // before falling back to the bare number.
      let label = `pr:${n}`;
      for (let p = el, hops = 0; p && hops < 3; p = p.parentElement, hops++) {
        const tip = p.getAttribute("title") || p.getAttribute("aria-label");
        if (tip && tip.trim().length > 8 && !/^pr[:#]?\s?\d+$/i.test(tip.trim())) {
          label = tip.trim().replace(/\s+/g, " ");
          break;
        }
      }
      const href = location.origin + location.pathname + "?tab=pr%3A" + n;
      prs.set(href, label);
    }
    return prs;
  }

  // TEMP DEBUG: survey the page's client-side storage (shared with content
  // scripts) so we can find where Devin keeps structured PR/session data,
  // instead of scraping the DOM. Shipped to the sink for inspection.
  let idbNames = [];
  try {
    if (indexedDB.databases) {
      indexedDB.databases().then((dbs) => {
        idbNames = dbs.map((d) => `${d.name} v${d.version}`);
      });
    }
  } catch (e) {}

  function collectPRsDebug() {
    const out = { localStorage: [], indexedDB: idbNames, samples: [] };
    try {
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        const v = localStorage.getItem(k) || "";
        out.localStorage.push(`${k} (${v.length}b)`);
        // sample values of keys that look session/PR related
        if (out.samples.length < 6 &&
            (/pr|pull|session|devin|tab/i.test(k) || /pull\/\d+|"pr"/.test(v))) {
          out.samples.push({ key: k, value: v.slice(0, 900) });
        }
      }
    } catch (e) {
      out.error = String(e);
    }
    return out;
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
    /waiting for instructions/i,
    /action required/i,
    /devin went to sleep/i,
    /capy is idle/i,
  ];

  function isAwaiting() {
    const text = document.body ? document.body.innerText : "";
    return AWAIT_PATTERNS.some((p) => p.test(text));
  }

  let lastAwaiting = null;

  function updateAwaitBorder() {
    let border = document.getElementById("wc-await-border");
    const awaiting = isAwaiting();
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
