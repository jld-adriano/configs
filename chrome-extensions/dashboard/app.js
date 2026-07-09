/* Devin/Capy session dashboard.
 *
 * Data sources (all optional, page degrades gracefully):
 *   - http://127.0.0.1:48291/state  window-colors sink (per-tab session reports)
 *   - http://127.0.0.1:48292/state  devin-stream sink (rich live session data)
 *   - ./aerospace-layout.json       symlinked by the launcher; maps windows to
 *                                   AeroSpace workspaces (join via tab URLs)
 */

"use strict";

const WC_URL = "http://127.0.0.1:48291/state";
const DS_URL = "http://127.0.0.1:48292/state";
const LAYOUT_URL = "aerospace-layout.json";

const POLL_WC_MS = 3000;
const POLL_DS_MS = 5000;
const POLL_LAYOUT_MS = 15000;
const STALE_MS = 90 * 1000;

const state = {
  wc: null,        // window-colors snapshot
  wcError: null,
  ds: null,        // devin-stream snapshot (incl. per-session summary)
  dsError: null,
  layout: null,    // aerospace layout cache
  layoutError: null,
  lastWcAt: 0,
  lastDsAt: 0,
  view: "sessions", // "sessions" | "prs"
};

const $ = (id) => document.getElementById(id);

/* ---------------- fetch loops ---------------- */

async function fetchJson(url) {
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function pollWc() {
  try {
    state.wc = await fetchJson(WC_URL);
    state.wcError = null;
    state.lastWcAt = Date.now();
  } catch (e) {
    state.wcError = String(e);
  }
  render();
}

async function pollDs() {
  try {
    state.ds = await fetchJson(DS_URL);
    state.dsError = null;
    state.lastDsAt = Date.now();
  } catch (e) {
    state.ds = null;
    state.dsError = String(e);
  }
  render();
}

async function pollLayout() {
  // Not available when opened via file:// — workspace grouping falls back.
  if (location.protocol === "file:") {
    state.layoutError = "file:// (no layout fetch)";
    return;
  }
  try {
    state.layout = await fetchJson(LAYOUT_URL);
    state.layoutError = null;
  } catch (e) {
    state.layout = null;
    state.layoutError = String(e);
  }
  render();
}

/* ---------------- helpers ---------------- */

function urlPathKey(u) {
  try {
    const p = new URL(u);
    return p.origin + p.pathname;
  } catch {
    return u;
  }
}

// Map url-path -> AeroSpace workspace, built from the layout cache's per-window
// Chrome tab inventory.
function buildWorkspaceMap() {
  const map = new Map();
  const wins = state.layout && state.layout.windows;
  if (!Array.isArray(wins)) return map;
  for (const w of wins) {
    if (w.ws == null || !w.chrome) continue;
    const tabs = [
      ...(Array.isArray(w.chrome.tabs) ? w.chrome.tabs : []),
      ...(w.chrome.active_tab ? [w.chrome.active_tab] : []),
    ];
    for (const t of tabs) {
      if (t && t.url) map.set(urlPathKey(t.url), w.ws);
    }
  }
  return map;
}

// Live shape: jsHeapUsed / jsHeapTotal / jsHeapLimit (bytes). Prefer the used
// heap; fall back to any numeric heap/mem field that isn't a limit.
function tabMemoryBytes(tab) {
  if (typeof tab.jsHeapUsed === "number") return tab.jsHeapUsed;
  let best = null;
  for (const [k, v] of Object.entries(tab)) {
    if (typeof v !== "number" || !/heap|mem/i.test(k) || /limit/i.test(k)) continue;
    const bytes = v > 1e6 ? v : v * 1024 * 1024; // small values assumed MB
    if (best === null || bytes > best) best = bytes;
  }
  return best;
}

function formatBytes(b) {
  if (b == null) return null;
  if (b >= 1024 ** 3) return (b / 1024 ** 3).toFixed(2) + " GB";
  if (b >= 1024 ** 2) return (b / 1024 ** 2).toFixed(0) + " MB";
  return (b / 1024).toFixed(0) + " KB";
}

function timeAgo(ms) {
  if (!ms) return "?";
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 60) return s + "s ago";
  if (s < 3600) return Math.round(s / 60) + "m ago";
  return (s / 3600).toFixed(1) + "h ago";
}

function esc(s) {
  const d = document.createElement("span");
  d.textContent = s == null ? "" : String(s);
  return d.innerHTML;
}

function prNumber(href) {
  const m = /\/pull\/(\d+)/.exec(href || "");
  return m ? "#" + m[1] : "";
}

/* ---------------- PR assembly ---------------- */

// Canonical PR list for a session. The devin-stream summary (captured Devin
// API payloads) is the source of truth for PR STATES; window-colors tab
// reports (localStorage-derived, open-only, but carrying PR titles) fill in
// titles and act as the fallback when the stream hasn't seen the session.
function sessionPRs(s) {
  const wcLabels = new Map((s.prs || []).map(([href, label]) => [href, label]));
  const summ = s.summary;
  if (summ && Array.isArray(summ.prs) && summ.prs.length) {
    return summ.prs.map((pr) => ({
      url: pr.url,
      number: pr.number || null,
      title: pr.title || wcLabels.get(pr.url) || null,
      // Fail closed: a missing/unknown state must NOT pass the open filter.
      state: pr.merged ? "merged" : pr.state || "unknown",
      draft: !!pr.draft,
    }));
  }
  return (s.prs || []).map(([href, label]) => ({
    url: href,
    number: null,
    title: label,
    // window-colors reports only PRs that passed its strict open predicate
    state: "open",
    draft: false,
  }));
}

function visiblePRs(s) {
  const prs = sessionPRs(s);
  if (!$("open-prs-only").checked) return prs;
  // Same strict predicate as the window-colors banner: verifiably open only.
  return prs.filter((pr) => pr.state === "open");
}

function prBadge(pr) {
  const cls = { open: "pr-open", merged: "pr-merged", closed: "pr-closed" }[pr.state] || "pr-closed";
  const label = pr.draft && pr.state === "open" ? "draft" : pr.state;
  return `<span class="pr-state ${pr.draft && pr.state === "open" ? "pr-draft" : cls}">${esc(label)}</span>`;
}

/* ---------------- session assembly ---------------- */

// Fold per-tab reports into one record per session key.
function buildSessions() {
  const tabs = (state.wc && state.wc.tabs) || [];
  const wsMap = buildWorkspaceMap();
  const dsSessions = (state.ds && state.ds.sessions) || {};
  const dsSummary = (state.ds && state.ds.summary) || {};
  const byKey = new Map();

  for (const tab of tabs) {
    const key = tab.key || tab.url;
    let s = byKey.get(key);
    if (!s) {
      s = {
        key,
        kind: tab.kind,
        title: tab.sessionTitle,
        url: tab.url,
        color: tab.color,
        symbol: tab.symbol,
        slot: tab.slot,
        awaiting: false,
        prs: [],
        tabCount: 0,
        reportedAt: 0,
        memBytes: null,
        workspace: null,
        stream: null,
      };
      byKey.set(key, s);
    }
    s.tabCount++;
    s.awaiting = s.awaiting || !!tab.awaiting;
    if ((tab.reportedAt || 0) > s.reportedAt) {
      s.reportedAt = tab.reportedAt || 0;
      s.title = tab.sessionTitle || s.title;
      s.url = tab.url || s.url;
    }
    if (Array.isArray(tab.prs) && tab.prs.length > s.prs.length) s.prs = tab.prs;
    const mem = tabMemoryBytes(tab);
    if (mem != null) s.memBytes = (s.memBytes || 0) + mem;
    if (s.workspace == null) {
      const ws = wsMap.get(urlPathKey(tab.url));
      if (ws != null) s.workspace = ws;
    }
  }

  // Join devin-stream sessions (keyed by session uuid == window-colors key for
  // devin tabs).
  for (const [sid, ds] of Object.entries(dsSessions)) {
    const s = byKey.get(sid);
    if (s) {
      s.stream = ds;
      if (typeof ds.awaiting === "boolean") s.awaiting = s.awaiting || ds.awaiting;
      if (!s.title && ds.title) s.title = ds.title;
    }
  }

  // Join the per-session summaries (captured-API titles, PR states, last
  // messages). The summary is the preferred source for session titles. Also
  // surface summary-only sessions not seen by window-colors, so the PRs view
  // covers everything the stream has tracked.
  for (const [sid, summ] of Object.entries(dsSummary)) {
    let s = byKey.get(sid);
    if (!s) {
      const ds = dsSessions[sid];
      s = {
        key: sid,
        kind: "devin",
        title: null,
        url: (ds && ds.url) || `https://app.devin.ai/sessions/${sid}`,
        color: null,
        symbol: null,
        slot: null,
        awaiting: false,
        prs: [],
        tabCount: 0,
        reportedAt: 0,
        memBytes: null,
        workspace: null,
        stream: ds || null,
      };
      byKey.set(sid, s);
    }
    s.summary = summ;
    if (summ.title) s.title = summ.title;
    // LLM enrichment (sink-side): decidedTitle/symbol are preferred for
    // display; rawTitle is kept for the tooltip. The slot color is untouched.
    if (summ.decidedTitle) s.decidedTitle = summ.decidedTitle;
    if (summ.rawTitle || summ.title) s.rawTitle = summ.rawTitle || summ.title;
    if (summ.symbol) s.symbol = summ.symbol;
  }

  return [...byKey.values()];
}

/* ---------------- rendering ---------------- */

function groupLabel(s, groupBy) {
  if (groupBy === "kind") return s.kind || "unknown";
  if (groupBy === "awaiting") return s.awaiting ? "awaiting instructions" : "working / idle";
  // workspace
  if (s.workspace != null) return "Workspace " + s.workspace;
  return state.layout ? "No workspace match" : "No workspace data";
}

function sortSessions(list, sortBy) {
  const cmp = {
    lastSeen: (a, b) => b.reportedAt - a.reportedAt,
    title: (a, b) => (a.title || "").localeCompare(b.title || ""),
    memory: (a, b) => (b.memBytes || 0) - (a.memBytes || 0),
    prs: (a, b) => sessionPRs(b).length - sessionPRs(a).length,
  }[sortBy] || (() => 0);
  // Awaiting sessions always float to the top within their group.
  return list.sort((a, b) => (b.awaiting - a.awaiting) || cmp(a, b));
}

function renderStats(sessions) {
  const tabs = (state.wc && state.wc.tabs) || [];
  const awaiting = sessions.filter((s) => s.awaiting).length;
  const totalMem = sessions.reduce((acc, s) => acc + (s.memBytes || 0), 0);
  const stats = [
    { label: "Sessions", num: sessions.length },
    { label: "Awaiting", num: awaiting, cls: "awaiting" },
    { label: "Tabs", num: tabs.length },
    { label: "Registry", num: (state.wc && state.wc.registrySize) ?? "–" },
  ];
  if (totalMem > 0) stats.push({ label: "Total memory", num: formatBytes(totalMem) });
  $("stats").innerHTML = stats
    .map(
      (s) =>
        `<div class="stat ${s.cls || ""}"><div class="num">${esc(s.num)}</div>` +
        `<div class="label">${esc(s.label)}</div></div>`
    )
    .join("");
}

function renderCard(s) {
  const stale = s.reportedAt && Date.now() - s.reportedAt > STALE_MS;
  const mem = formatBytes(s.memBytes);
  const meta = [];
  meta.push(
    `<span class="${stale ? "fresh-old" : ""}" title="last report from extension">` +
      `${esc(timeAgo(s.reportedAt))}</span>`
  );
  if (s.tabCount > 1) meta.push(`<span>${s.tabCount} tabs</span>`);
  if (mem) meta.push(`<span title="JS heap">▦ ${esc(mem)}</span>`);
  if (s.workspace != null) meta.push(`<span>ws ${esc(s.workspace)}</span>`);
  meta.push(`<span class="badge badge-kind">${esc(s.kind)}</span>`);

  let prsHtml = "";
  const prs = visiblePRs(s);
  if (prs.length) {
    const items = prs
      .map(
        (pr) =>
          `<li><a href="${esc(pr.url)}" target="_blank" rel="noopener">` +
          `<span class="pr-num">${esc(prNumber(pr.url))}</span> ` +
          `${esc(pr.title || pr.url)}</a> ${prBadge(pr)}</li>`
      )
      .join("");
    prsHtml =
      `<details class="prs"><summary>${prs.length} PR${prs.length > 1 ? "s" : ""}</summary>` +
      `<ul>${items}</ul></details>`;
  }

  let msgsHtml = "";
  if (s.summary) {
    // Last 4 back-and-forth chat messages (oldest -> newest), falling back to
    // the older two-field shape for pre-recentMessages summaries.
    let rows;
    if (Array.isArray(s.summary.recentMessages) && s.summary.recentMessages.length) {
      rows = s.summary.recentMessages
        .filter((m) => m && m.text)
        .slice(-4)
        .map((m) => `<div class="last-msg">${m.role === "human" ? "👤" : "🤖"} ${esc(m.text)}</div>`);
    } else {
      rows = [];
      if (s.summary.lastHumanMessage)
        rows.push(`<div class="last-msg">👤 ${esc(s.summary.lastHumanMessage)}</div>`);
      if (s.summary.lastAgentMessage)
        rows.push(`<div class="last-msg">🤖 ${esc(s.summary.lastAgentMessage)}</div>`);
    }
    if (rows.length) msgsHtml = `<div class="last-msgs">${rows.join("")}</div>`;
  }

  let streamHtml = "";
  if (s.stream) {
    const bits = [];
    if (s.stream.status) bits.push(`status: ${esc(s.stream.status)}`);
    if (s.stream.events) bits.push(`${esc(s.stream.events)} events`);
    if (s.stream.lastSeen) bits.push(`stream: ${esc(s.stream.lastSeen)}`);
    if (bits.length) streamHtml = `<div class="stream-extra">⇄ ${bits.join(" · ")}</div>`;
  }

  const badge = s.awaiting
    ? `<span class="badge badge-awaiting">awaiting</span>`
    : `<span class="badge badge-active">working</span>`;

  return (
    `<div class="card ${s.awaiting ? "awaiting" : ""} ${stale ? "stale" : ""}"` +
    ` style="--card-color:${esc(s.color || "transparent")}">` +
    `<div class="card-head">` +
    `<span class="symbol">${esc(s.symbol || "")}</span>` +
    `<span class="card-title"><a href="${esc(s.url)}" target="_blank" rel="noopener"` +
    (s.decidedTitle && s.rawTitle ? ` title="${esc(s.rawTitle)}"` : "") + `>` +
    `${esc(s.decidedTitle || s.title || "(untitled session)")}</a></span>` +
    badge +
    `</div>` +
    `<div class="card-meta">${meta.join("")}</div>` +
    msgsHtml +
    prsHtml +
    streamHtml +
    `<details class="card-debug"><summary>{ }</summary>` +
    `<pre>${esc(JSON.stringify(s, null, 2))}</pre></details>` +
    `</div>`
  );
}

function renderGroups(sessions) {
  const groupBy = $("group-by").value;
  const sortBy = $("sort-by").value;
  const awaitingOnly = $("awaiting-only").checked;
  const q = $("filter-text").value.trim().toLowerCase();

  let list = sessions;
  if (awaitingOnly) list = list.filter((s) => s.awaiting);
  if (q) {
    list = list.filter(
      (s) =>
        ((s.title || "") + " " + (s.decidedTitle || "")).toLowerCase().includes(q) ||
        sessionPRs(s).some((pr) => ((pr.title || "") + " " + pr.url).toLowerCase().includes(q))
    );
  }

  const groups = new Map();
  for (const s of list) {
    const g = groupLabel(s, groupBy);
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push(s);
  }

  const orderedKeys = [...groups.keys()].sort((a, b) => {
    // Numeric-aware ordering so "Workspace 2" < "Workspace 10"; fallbacks last.
    const na = /(\d+)/.exec(a), nb = /(\d+)/.exec(b);
    if (na && nb) return Number(na[1]) - Number(nb[1]);
    if (na) return -1;
    if (nb) return 1;
    return a.localeCompare(b);
  });

  if (!orderedKeys.length) {
    $("groups").innerHTML = state.wcError
      ? `<div class="empty">window-colors sink unreachable at ${esc(WC_URL)} — ${esc(state.wcError)}</div>`
      : `<div class="empty">No sessions${awaitingOnly || q ? " match the filter" : " reported yet"}.</div>`;
    return;
  }

  $("groups").innerHTML = orderedKeys
    .map((g) => {
      const items = sortSessions(groups.get(g), sortBy);
      const nAwait = items.filter((s) => s.awaiting).length;
      return (
        `<section class="group"><h2 class="group-title">${esc(g)}` +
        `<span class="count">${items.length}</span>` +
        (nAwait ? `<span class="awaiting-n">⚠ ${nAwait} awaiting</span>` : "") +
        `</h2><div class="cards">${items.map(renderCard).join("")}</div></section>`
      );
    })
    .join("");
}

// Big flat list of every tracked PR, grouped by session. Sessions come from
// the devin-stream summary first (authoritative states) with window-colors
// tab reports as the fallback; the open-only toggle applies here too.
function renderPrsView(sessions) {
  const q = $("filter-text").value.trim().toLowerCase();
  const openOnly = $("open-prs-only").checked;

  const groups = [];
  let totalShown = 0;
  let totalAll = 0;
  for (const s of sessions) {
    const all = sessionPRs(s);
    totalAll += all.length;
    let prs = visiblePRs(s);
    if (q) {
      prs = prs.filter(
        (pr) =>
          ((pr.title || "") + " " + pr.url + " " + (s.title || ""))
            .toLowerCase()
            .includes(q)
      );
    }
    if (!prs.length) continue;
    totalShown += prs.length;
    groups.push({ s, prs });
  }

  // Freshest sessions first (summary lastSeen, then extension report time).
  groups.sort((a, b) => {
    const at = String((a.s.summary && a.s.summary.lastSeen) || "");
    const bt = String((b.s.summary && b.s.summary.lastSeen) || "");
    return bt.localeCompare(at) || b.s.reportedAt - a.s.reportedAt;
  });

  if (!groups.length) {
    $("prs-view").innerHTML =
      `<div class="empty">No ${openOnly ? "open " : ""}PRs tracked` +
      `${q ? " match the filter" : ""} (${totalAll} total across sessions).</div>`;
    return;
  }

  $("prs-view").innerHTML =
    `<div class="prs-total">${totalShown} PR${totalShown !== 1 ? "s" : ""}` +
    `${openOnly ? " open" : ""} across ${groups.length} session${groups.length !== 1 ? "s" : ""}` +
    ` · ${totalAll} tracked in total</div>` +
    groups
      .map(({ s, prs }) => {
        const rows = prs
          .map(
            (pr) =>
              `<li class="pr-row">` +
              `<a href="${esc(pr.url)}" target="_blank" rel="noopener">` +
              `<span class="pr-num">${esc(pr.number ? "#" + pr.number : prNumber(pr.url))}</span> ` +
              `${esc(pr.title || pr.url.replace(/^https:\/\/github\.com\//, ""))}</a> ` +
              prBadge(pr) +
              `</li>`
          )
          .join("");
        return (
          `<section class="pr-group" style="--card-color:${esc(s.color || "transparent")}">` +
          `<h2 class="pr-group-title">` +
          `<span class="symbol">${esc(s.symbol || "")}</span>` +
          `<a href="${esc(s.url)}" target="_blank" rel="noopener"` +
          (s.decidedTitle && s.rawTitle ? ` title="${esc(s.rawTitle)}"` : "") + `>` +
          `${esc(s.decidedTitle || s.title || s.key)}</a>` +
          `<span class="count">${prs.length}</span>` +
          `</h2><ul class="pr-list">${rows}</ul></section>`
        );
      })
      .join("");
}

function renderStreamPanel() {
  const dot = $("ds-dot");
  const statusEl = $("stream-status");
  const body = $("stream-body");

  if (!state.ds) {
    dot.className = "dot dot-off";
    statusEl.textContent = "port 48292 unreachable";
    body.innerHTML =
      `<div class="waiting">waiting for devin-stream… ` +
      `(load the extension from chrome-extensions/devin-stream/ and start its sink)</div>`;
    return;
  }

  dot.className = "dot dot-on";
  statusEl.textContent = "updated " + esc(state.ds.updatedAt || "?");
  const sessions = Object.values(state.ds.sessions || {});
  if (!sessions.length) {
    body.innerHTML = `<div class="waiting">sink reachable, no session events yet</div>`;
    return;
  }
  sessions.sort((a, b) => String(b.lastSeen || "").localeCompare(String(a.lastSeen || "")));
  const rows = sessions
    .map(
      (s) =>
        `<tr><td><a href="${esc(s.url || "#")}" target="_blank" rel="noopener">` +
        `${esc(s.title || s.sessionId)}</a></td>` +
        `<td>${esc(s.status || (s.awaiting ? "awaiting" : ""))}</td>` +
        `<td>${esc(s.events ?? "")}</td>` +
        `<td>${esc(s.lastSeen || "")}</td></tr>`
    )
    .join("");
  body.innerHTML =
    `<table><thead><tr><th>Session</th><th>Status</th><th>Events</th><th>Last seen</th></tr></thead>` +
    `<tbody>${rows}</tbody></table>`;
}

function render() {
  $("wc-dot").className = "dot " + (state.wcError ? "dot-err" : state.wc ? "dot-on" : "dot-off");
  $("ws-dot").className = "dot " + (state.layout ? "dot-on" : "dot-off");
  $("ws-dot").title = state.layout
    ? `aerospace-layout.json (locked_at ${state.layout.locked_at || "?"})`
    : `aerospace layout unavailable: ${state.layoutError || "not loaded yet"}`;

  const sessions = buildSessions();
  renderStats(sessions);
  $("groups").hidden = state.view !== "sessions";
  $("prs-view").hidden = state.view !== "prs";
  if (state.view === "prs") renderPrsView(sessions);
  else renderGroups(sessions);
  renderStreamPanel();

  const parts = [];
  if (state.wc) parts.push(`window-colors snapshot ts ${state.wc.ts}`);
  if (state.wcError) parts.push(`window-colors error: ${state.wcError}`);
  if (state.layoutError && !state.layout) parts.push(`workspace map: ${state.layoutError}`);
  $("footer").textContent = parts.join(" · ");
}

/* ---------------- boot ---------------- */

for (const id of ["group-by", "sort-by", "awaiting-only", "open-prs-only", "filter-text"]) {
  $(id).addEventListener("input", render);
}

for (const btn of document.querySelectorAll("#view-tabs .view-tab")) {
  btn.addEventListener("click", () => {
    state.view = btn.dataset.view;
    for (const b of document.querySelectorAll("#view-tabs .view-tab")) {
      b.classList.toggle("active", b === btn);
    }
    render();
  });
}

pollWc();
pollDs();
pollLayout();
setInterval(pollWc, POLL_WC_MS);
setInterval(pollDs, POLL_DS_MS);
setInterval(pollLayout, POLL_LAYOUT_MS);
setInterval(render, 10000); // keep "ago" freshness labels current
