const socket = io();
let role = "host";
let state = null;
let myPlayerId = sessionStorage.getItem("tpPlayerId") || localStorage.getItem("tpPlayerId") || null;
let playerReconnectToken = sessionStorage.getItem("tpPlayerReconnectToken") || localStorage.getItem("tpPlayerReconnectToken") || null;
let playerGameCode = sessionStorage.getItem("tpPlayerGameCode") || localStorage.getItem("tpPlayerGameCode") || null;
let hostToken = sessionStorage.getItem("tpHostToken") || localStorage.getItem("tpHostToken") || null;
let hostGameCode = sessionStorage.getItem("tpHostGameCode") || localStorage.getItem("tpHostGameCode") || null;
let previousVisualState = null;
let transitionTimer = null;
let finalOptionsTimer = null;
let audioContext = null;
let roomCodeHidden = localStorage.getItem("tpRoomCodeHidden") === "1";
let statsChartModes = {};
let clockOffset = 0; // serverTime - clientTime
const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

const $ = id => document.getElementById(id);
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;" }[c]));
const serverNow = () => Date.now() + clockOffset;
const LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";

/* ------------------------------------------------------------------ *
 * DOM morphing: update only what changed so CSS transitions play and
 * nodes (and their entrance animations) persist between server updates.
 * Elements with a data-key are replaced when the key changes, which is
 * how new questions/stages get a fresh entrance animation.
 * Elements with data-live manage their own children (e.g. score counters).
 * ------------------------------------------------------------------ */
function patch(el, html) {
  if (!el) return;
  const tpl = document.createElement("template");
  tpl.innerHTML = html;
  morphChildren(el, tpl.content);
}
function nodeKey(n) { return n.nodeType === 1 ? (n.getAttribute("data-key") || "") : ""; }
function sameNode(a, b) {
  return a.nodeType === b.nodeType && a.nodeName === b.nodeName && nodeKey(a) === nodeKey(b);
}
function morphChildren(target, source) {
  const keyed = new Map();
  for (const n of target.childNodes) { const k = nodeKey(n); if (k) keyed.set(k, n); }
  const sourceKids = [...source.childNodes];
  let i = 0;
  for (const s of sourceKids) {
    let t = target.childNodes[i];
    const k = nodeKey(s);
    if (k && keyed.has(k) && keyed.get(k) !== t) {
      t = keyed.get(k);
      target.insertBefore(t, target.childNodes[i] || null);
    }
    if (t && sameNode(t, s)) morphNode(t, s);
    else target.insertBefore(s, t || null);
    i++;
  }
  while (target.childNodes.length > i) target.removeChild(target.lastChild);
}
function morphNode(t, s) {
  if (t.nodeType === 3 || t.nodeType === 8) {
    if (t.nodeValue !== s.nodeValue) t.nodeValue = s.nodeValue;
    return;
  }
  if (t.nodeType !== 1) return;
  for (const attr of [...t.attributes]) if (!s.hasAttribute(attr.name)) t.removeAttribute(attr.name);
  for (const attr of [...s.attributes]) {
    if (t.getAttribute(attr.name) !== attr.value) {
      t.setAttribute(attr.name, attr.value);
      if (t.nodeName === "INPUT" && attr.name === "value" && document.activeElement !== t) t.value = attr.value;
    }
  }
  if (t.nodeName === "BUTTON" || t.nodeName === "INPUT") t.disabled = s.hasAttribute("disabled");
  if (t.hasAttribute("data-live")) return;
  morphChildren(t, s);
}

/* FLIP reorder animation for keyed lists (standings). */
function flip(container, mutate) {
  const before = new Map();
  container.querySelectorAll("[data-key]").forEach(el => before.set(el.dataset.key, el.getBoundingClientRect().top));
  mutate();
  if (reduceMotion) return;
  container.querySelectorAll("[data-key]").forEach(el => {
    const prev = before.get(el.dataset.key);
    if (prev == null) return;
    const dy = prev - el.getBoundingClientRect().top;
    if (Math.abs(dy) < 1) return;
    el.animate([{ transform: `translateY(${dy}px)` }, { transform: "none" }], { duration: 480, easing: "cubic-bezier(.2,.8,.2,1)" });
  });
}

/* Animated score counters: [data-score] elements count up to their value. */
function runCounters(root = document) {
  root.querySelectorAll("[data-score]").forEach(el => {
    const target = Number(el.dataset.score) || 0;
    const from = el.__shown ?? target;
    if (el.__target === target && el.textContent) return;
    el.__target = target;
    cancelAnimationFrame(el.__raf);
    if (from === target || reduceMotion) { el.__shown = target; el.textContent = target.toLocaleString(); return; }
    const delta = target - from;
    if (delta > 0) floatScore(el, `+${delta.toLocaleString()}`);
    const start = performance.now(), dur = 900;
    const step = now => {
      const p = Math.min(1, (now - start) / dur);
      const eased = 1 - Math.pow(1 - p, 3);
      el.__shown = Math.round(from + delta * eased);
      el.textContent = el.__shown.toLocaleString();
      if (p < 1) el.__raf = requestAnimationFrame(step);
    };
    el.__raf = requestAnimationFrame(step);
  });
}
function floatScore(el, text) {
  const host = el.closest("[data-score-host]");
  if (!host) return;
  const f = document.createElement("span");
  f.className = "score-float";
  f.textContent = text;
  host.appendChild(f);
  setTimeout(() => f.remove(), 1400);
}

/* ------------------------------------------------------------------ *
 * Toasts and dialogs (replace alert/confirm)
 * ------------------------------------------------------------------ */
function toast(message, kind = "info", ms = 3600) {
  if (!message) return;
  const el = document.createElement("div");
  el.className = `toast toast-${kind}`;
  el.textContent = message;
  $("toasts").appendChild(el);
  requestAnimationFrame(() => el.classList.add("show"));
  setTimeout(() => { el.classList.remove("show"); setTimeout(() => el.remove(), 300); }, ms);
}

let dialogResolve = null;
function askDialog({ title, body = "", actions = [{ label: "OK", value: true, kind: "primary" }], dismissValue = null }) {
  const dlg = $("dialog");
  $("dialogTitle").textContent = title;
  $("dialogBody").textContent = body;
  $("dialogBody").hidden = !body;
  $("dialogActions").innerHTML = actions.map((a, i) => `<button type="button" data-dialog-index="${i}" class="${a.kind || ""}">${esc(a.label)}</button>`).join("");
  dlg.hidden = false;
  requestAnimationFrame(() => dlg.classList.add("show"));
  return new Promise(resolve => {
    const close = value => {
      dlg.classList.remove("show");
      document.removeEventListener("keydown", onKey, true);
      setTimeout(() => { dlg.hidden = true; }, 200);
      dialogResolve = null;
      resolve(value);
    };
    dialogResolve = close;
    const onKey = e => { if (e.key === "Escape") { e.stopPropagation(); close(dismissValue); } };
    document.addEventListener("keydown", onKey, true);
    $("dialogActions").querySelectorAll("[data-dialog-index]").forEach(btn => btn.onclick = () => close(actions[+btn.dataset.dialogIndex].value));
    dlg.querySelector(".dialog-backdrop").onclick = () => close(dismissValue);
    const primary = $("dialogActions").querySelector(".primary") || $("dialogActions").querySelector("button");
    setTimeout(() => primary?.focus(), 30);
  });
}

/* ------------------------------------------------------------------ *
 * Stats charts
 * ------------------------------------------------------------------ */
function statsPercent(correct, total) { return total ? (correct / total) * 100 : 0; }

function setupCanvas(canvas, height) {
  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  const width = Math.max(320, Math.floor(rect.width || 760));
  canvas.width = width * dpr; canvas.height = height * dpr;
  const ctx = canvas.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { ctx, width, height };
}
const CHART_FONT = "Figtree, system-ui, sans-serif";

function drawStatsBarChart(canvas, playerStats, progress = 1) {
  const { ctx, width, height } = setupCanvas(canvas, 340);
  ctx.clearRect(0, 0, width, height);
  const left = 48, right = 12, top = 24, bottom = 58;
  const chartW = width - left - right, chartH = height - top - bottom;
  ctx.lineWidth = 1; ctx.font = `600 12px ${CHART_FONT}`;
  for (let pct = 0; pct <= 100; pct += 25) {
    const y = top + chartH - (pct / 100) * chartH;
    ctx.strokeStyle = pct === 0 ? "#5b5aa0" : "#33326b";
    ctx.beginPath(); ctx.moveTo(left, y); ctx.lineTo(left + chartW, y); ctx.stroke();
    ctx.fillStyle = "#a7a6d9"; ctx.textAlign = "right"; ctx.fillText(`${pct}%`, left - 8, y + 4);
  }
  const cats = playerStats.categories || [];
  const slot = chartW / Math.max(cats.length, 1);
  const barW = Math.min(64, slot * 0.6);
  cats.forEach((cat, i) => {
    const pct = statsPercent(cat.correct, cat.total);
    const h = chartH * pct / 100 * progress;
    const x = left + i * slot + (slot - barW) / 2;
    const y = top + chartH - h;
    ctx.fillStyle = colorValue(cat.color);
    roundRectTop(ctx, x, y, barW, h, Math.min(8, h));
    ctx.fillStyle = "#f5f4ff"; ctx.font = `800 13px ${CHART_FONT}`; ctx.textAlign = "center";
    ctx.globalAlpha = progress;
    ctx.fillText(`${Math.round(pct)}%`, x + barW / 2, Math.max(top + 12, y - 8));
    ctx.globalAlpha = 1;
    ctx.fillStyle = "#c9c8ee"; ctx.font = `700 12px ${CHART_FONT}`;
    wrapLines(ctx, String(cat.name || cat.color), slot - 8, 2).forEach((line, li) => ctx.fillText(line, x + barW / 2, top + chartH + 20 + li * 15));
  });
}
function wrapLines(ctx, text, maxW, maxLines) {
  const words = text.split(/\s+/);
  const lines = [];
  let line = "";
  for (const w of words) {
    const test = line ? `${line} ${w}` : w;
    if (ctx.measureText(test).width <= maxW || !line) line = test;
    else { lines.push(line); line = w; }
  }
  if (line) lines.push(line);
  if (lines.length > maxLines) {
    const kept = lines.slice(0, maxLines);
    let last = kept[maxLines - 1] + "…";
    while (ctx.measureText(last).width > maxW && last.length > 2) last = last.slice(0, -2) + "…";
    kept[maxLines - 1] = last;
    return kept;
  }
  return lines;
}
function roundRectTop(ctx, x, y, w, h, r) {
  if (h <= 0) return;
  ctx.beginPath();
  ctx.moveTo(x, y + h); ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y); ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r); ctx.lineTo(x + w, y + h);
  ctx.closePath(); ctx.fill();
}

function drawStatsPieChart(canvas, playerStats, progress = 1) {
  const { ctx, width, height } = setupCanvas(canvas, 340);
  ctx.clearRect(0, 0, width, height);
  const cats = playerStats.categories || [];
  const total = cats.reduce((sum, c) => sum + (c.total || 0), 0);
  const narrow = width < 560;
  const radius = narrow ? Math.min(110, width / 2 - 20) : 130;
  const cx = narrow ? width / 2 : Math.min(width * 0.32, 220), cy = narrow ? radius + 12 : 170;
  if (!total) { ctx.fillStyle = "#a7a6d9"; ctx.font = `700 16px ${CHART_FONT}`; ctx.textAlign = "center"; ctx.fillText("No questions answered", width / 2, height / 2); return; }
  let start = -Math.PI / 2;
  const sweep = Math.PI * 2 * progress;
  cats.forEach(cat => {
    const value = cat.total || 0; if (!value) return;
    const end = start + sweep * value / total;
    ctx.beginPath(); ctx.moveTo(cx, cy); ctx.arc(cx, cy, radius, start, end); ctx.closePath();
    ctx.fillStyle = colorValue(cat.color); ctx.fill();
    ctx.strokeStyle = "#1d1c4d"; ctx.lineWidth = 3; ctx.stroke();
    start = end;
  });
  if (narrow) return; // legend is rendered as HTML below the canvas on small screens
  const lx = cx + radius + 48;
  cats.forEach((cat, i) => {
    const y = 64 + i * 40;
    ctx.fillStyle = colorValue(cat.color);
    ctx.beginPath(); ctx.arc(lx + 8, y - 4, 8, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = "#f5f4ff"; ctx.font = `700 14px ${CHART_FONT}`; ctx.textAlign = "left";
    ctx.fillText(`${cat.name}`, lx + 26, y + 1);
    ctx.fillStyle = "#a7a6d9"; ctx.font = `600 13px ${CHART_FONT}`;
    ctx.fillText(`${cat.correct || 0}/${cat.total || 0} correct`, lx + 26 + ctx.measureText(`${cat.name}  `).width + 30, y + 1);
  });
}

function drawStats(canvas, player, animate) {
  const mode = statsChartModes[player.playerId] || "bar";
  const draw = p => mode === "pie" ? drawStatsPieChart(canvas, player, p) : drawStatsBarChart(canvas, player, p);
  if (!animate || reduceMotion) return draw(1);
  const start = performance.now();
  const step = now => {
    const p = Math.min(1, (now - start) / 700);
    draw(1 - Math.pow(1 - p, 3));
    if (p < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

function renderStatsModal(animateId = "all") {
  const content = $("statsContent");
  const stats = state?.playerStats || [];
  if (!stats.length) { content.innerHTML = '<div class="stats-empty">No player statistics are available.</div>'; return; }
  content.innerHTML = stats.map(player => {
    const mode = statsChartModes[player.playerId] || "bar";
    const answered = player.categories.reduce((a, c) => a + c.total, 0);
    const correct = player.categories.reduce((a, c) => a + (c.correct || 0), 0);
    const legend = mode === "pie" ? `<div class="stats-legend">${player.categories.map(c => `<span><i style="background:${esc(colorValue(c.color))}"></i>${esc(c.name)} <b>${c.correct || 0}/${c.total || 0}</b></span>`).join("")}</div>` : "";
    return `<section class="stats-player"><div class="stats-player-title"><h3>${esc(player.playerName)}</h3><span>${correct} of ${answered} correct</span>
      <div class="segmented" role="group" aria-label="Chart type"><button data-stats-mode="bar" data-stats-id="${esc(player.playerId)}" class="${mode === "bar" ? "on" : ""}">Bars</button><button data-stats-mode="pie" data-stats-id="${esc(player.playerId)}" class="${mode === "pie" ? "on" : ""}">Pie</button></div></div>
      <canvas class="stats-canvas" data-stats-player="${esc(player.playerId)}"></canvas>${legend}</section>`;
  }).join("");
  stats.forEach(player => {
    const canvas = content.querySelector(`[data-stats-player="${CSS.escape(player.playerId)}"]`);
    drawStats(canvas, player, animateId === "all" || animateId === player.playerId);
  });
  content.querySelectorAll("[data-stats-mode]").forEach(btn => btn.onclick = () => {
    const id = btn.dataset.statsId;
    if ((statsChartModes[id] || "bar") === btn.dataset.statsMode) return;
    statsChartModes[id] = btn.dataset.statsMode;
    renderStatsModal(id);
  });
}

function openStats() {
  if (!state || state.status !== "finished" || !state.playerStats) return;
  const modal = $("statsModal");
  modal.hidden = false;
  requestAnimationFrame(() => modal.classList.add("show"));
  renderStatsModal("all");
}
function closeStats() {
  const modal = $("statsModal");
  modal.classList.remove("show");
  setTimeout(() => { modal.hidden = true; }, 220);
}

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */
function categoryInfo(name) {
  const key = String(name || "").toLowerCase();
  return state?.categories?.find(c => String(c.name).toLowerCase() === key || String(c.color).toLowerCase() === key) || { name, color: "#777" };
}

function colorValue(color) {
  const known = { pink:"#e85aa8", orange:"#f28c28", yellow:"#e7c83b", green:"#43a86b", blue:"#4d82d9", purple:"#8b5bc7" };
  return known[String(color || "").toLowerCase()] || color || "#777";
}

function categoryIndexFor(wedge) {
  const cats = state?.categories || [];
  const key = String(wedge || "").toLowerCase();
  let idx = cats.findIndex(c => String(c.name).toLowerCase() === key || String(c.color).toLowerCase() === key);
  if (idx < 0) idx = cats.findIndex(c => colorValue(c.color).toLowerCase() === colorValue(wedge).toLowerCase());
  return idx;
}

// Each category owns a fixed slot in the pie, like the board-game token.
function wedgeSlots(wedges = []) {
  const slots = new Array(6).fill(null);
  const leftovers = [];
  (Array.isArray(wedges) ? wedges : []).forEach(w => {
    const idx = categoryIndexFor(w);
    if (idx >= 0 && idx < 6 && !slots[idx]) slots[idx] = w; else leftovers.push(w);
  });
  leftovers.forEach(w => { const free = slots.indexOf(null); if (free >= 0) slots[free] = w; });
  return slots;
}

function wedgeCircleHTML(wedges = [], { highlight = -1, cls = "" } = {}) {
  const earned = Array.isArray(wedges) ? wedges : [];
  const slots = wedgeSlots(earned);
  const cx = 50, cy = 50, r = 46;
  const paths = slots.map((w, i) => {
    const a1 = (-90 + i * 60) * Math.PI / 180;
    const a2 = (-30 + i * 60) * Math.PI / 180;
    const x1 = cx + r * Math.cos(a1), y1 = cy + r * Math.sin(a1);
    const x2 = cx + r * Math.cos(a2), y2 = cy + r * Math.sin(a2);
    const color = w ? colorValue(categoryInfo(w).color || w) : null;
    const slotCls = `slice${w ? " earned" : ""}${i === highlight ? " slice-new" : ""}`;
    const fill = color ? `style="fill:${esc(color)}"` : "";
    return `<path class="${slotCls}" ${fill} d="M ${cx} ${cy} L ${x1.toFixed(2)} ${y1.toFixed(2)} A ${r} ${r} 0 0 1 ${x2.toFixed(2)} ${y2.toFixed(2)} Z"><title>${esc(w ? (categoryInfo(w).name || w) : "Not earned yet")}</title></path>`;
  });
  return `<svg class="wedge-circle ${cls}" viewBox="0 0 100 100" role="img" aria-label="${earned.length} of 6 wedges earned"><circle class="pie-base" cx="50" cy="50" r="48"></circle>${paths.join("")}</svg>`;
}

function me() { return state?.players?.find(p => p.id === myPlayerId) || null; }

function vibrate(pattern) { try { navigator.vibrate?.(pattern); } catch {} }

/* ------------------------------------------------------------------ *
 * Role switching and setup
 * ------------------------------------------------------------------ */
function switchRole(next) {
  role = next;
  $("hostScreen").hidden = role !== "host";
  $("playerScreen").hidden = role !== "player";
  $("hostTab").classList.toggle("active", role === "host");
  $("playerTab").classList.toggle("active", role === "player");
  document.body.dataset.role = role;
  render();
}

if (playerGameCode) $("joinCode").value = playerGameCode;
const savedPlayerName = sessionStorage.getItem("tpPlayerName") || localStorage.getItem("tpPlayerName") || "";
if (savedPlayerName) $("playerName").value = savedPlayerName;

// Pick a sensible starting view: links with ?code= and phones go to the player screen.
(() => {
  const params = new URLSearchParams(location.search);
  const urlCode = (params.get("code") || params.get("join") || "").toUpperCase().slice(0, 6);
  if (urlCode) $("joinCode").value = urlCode;
  const phone = window.matchMedia("(max-width: 700px), (pointer: coarse) and (max-width: 1024px)").matches;
  const startAsPlayer = urlCode || params.get("role") === "player" || (!hostToken && (playerReconnectToken || phone));
  switchRole(startAsPlayer && params.get("role") !== "host" ? "player" : "host");
})();

$("hostTab").onclick = () => switchRole("host");
$("playerTab").onclick = () => switchRole("player");
$("fullscreenHost").onclick = async () => { try { if (!document.fullscreenElement) await document.documentElement.requestFullscreen(); else await document.exitFullscreen(); } catch {} };
document.addEventListener("fullscreenchange", () => { $("fullscreenHost").textContent = document.fullscreenElement ? "Exit full screen" : "Full screen"; });
$("showStats").onclick = openStats;
$("toggleRoomCode").onclick = () => {
  roomCodeHidden = !roomCodeHidden;
  localStorage.setItem("tpRoomCodeHidden", roomCodeHidden ? "1" : "0");
  render();
};
$("workbook").onchange = () => { $("workbookName").textContent = $("workbook").files[0]?.name || "Choose an .xlsx or .csv file"; };

$("newGame").onclick = async () => {
  const ok = await askDialog({
    title: "Start a new game?",
    body: "This clears the question set, used-question history, stats, points and wedges. You'll need to upload a workbook again.",
    actions: [{ label: "Cancel", value: false, kind: "ghost" }, { label: "Start new game", value: true, kind: "danger" }],
    dismissValue: false
  });
  if (!ok) return;
  socket.emit("host:new-game", {}, result => {
    if (!result.ok) return setStatus("hostReveal", result.error, true);
    $("workbook").value = "";
    $("workbookName").textContent = "Choose an .xlsx or .csv file";
    setStatus("uploadStatus", "No workbook uploaded.", false);
    statsChartModes = {};
  });
};
$("playAgain").onclick = async () => {
  const keepStats = await askDialog({
    title: "Play again",
    body: "Same workbook, fresh questions. Should player stats carry over into the next game?",
    actions: [{ label: "Cancel", value: null, kind: "ghost" }, { label: "Reset stats", value: false }, { label: "Keep stats", value: true, kind: "primary" }],
    dismissValue: null
  });
  if (keepStats === null) return;
  socket.emit("host:play-again", { keepStats }, result => {
    if (!result.ok) {
      if (result.resetQuestionSet) {
        $("workbook").value = "";
        $("workbookName").textContent = "Choose an .xlsx or .csv file";
        setStatus("uploadStatus", "No workbook uploaded. Upload a new question set.", false);
        statsChartModes = {};
        askDialog({ title: "Not enough questions left", body: result.error });
        return;
      }
      return setStatus("hostReveal", result.error, true);
    }
    statsChartModes = {};
  });
};
$("closeStats").onclick = closeStats;
$("statsModal").querySelector(".stats-modal-backdrop").onclick = closeStats;
document.addEventListener("keydown", e => { if (e.key === "Escape" && !$("statsModal").hidden) closeStats(); });
window.addEventListener("resize", () => { if (!$("statsModal").hidden) renderStatsModal("none"); });

$("createGame").onclick = async () => {
  $("createGame").disabled = true;
  try {
    const response = await fetch("/api/games", { method:"POST", headers:{ "Content-Type":"application/json" }, body:"{}" });
    const data = await response.json();
    hostToken = data.hostToken;
    hostGameCode = data.code;
    sessionStorage.setItem("tpHostToken", hostToken);
    sessionStorage.setItem("tpHostGameCode", hostGameCode);
    localStorage.setItem("tpHostToken", hostToken);
    localStorage.setItem("tpHostGameCode", hostGameCode);
    $("hostCode").textContent = data.code;
    $("joinCode").value = data.code;
    connectHost(data.code, data.hostToken);
  } catch {
    setStatus("hostStatus", "Couldn't create a game. Check the server is running and try again.", true);
  } finally {
    $("createGame").disabled = false;
  }
};

$("uploadWorkbook").onclick = async () => {
  if (!state) return setStatus("uploadStatus", "Create a game first.", true);
  const file = $("workbook").files[0];
  if (!file) return setStatus("uploadStatus", "Choose your Excel workbook first.", true);
  const form = new FormData();
  form.append("workbook", file);
  const btn = $("uploadWorkbook");
  btn.disabled = true; btn.classList.add("busy");
  try {
    const response = await fetch(`/api/games/${state.code}/questions`, { method:"POST", body:form });
    const data = await response.json();
    if (!response.ok) return setStatus("uploadStatus", [data.error, ...(data.details || [])].join("\n"), true);
    setStatus("uploadStatus", `Validated ${data.questionCount} questions and ${data.finalGroups} final-round groups.`, false);
    toast("Workbook loaded — you can start the game.", "ok");
  } catch {
    setStatus("uploadStatus", "Upload failed. Check your connection and try again.", true);
  } finally {
    btn.disabled = false; btn.classList.remove("busy");
  }
};

$("saveCategories").onclick = () => {
  const categories = [...document.querySelectorAll("#categoryEditor .category")].map(row => ({
    color: row.dataset.color, name: row.querySelector("input").value.trim()
  }));
  socket.emit("host:categories", { categories }, result => {
    if (!result.ok) setStatus("hostStatus", result.error, true);
    else toast("Categories saved.", "ok");
  });
};

const hostAction = (event, label) => () => socket.emit(event, {}, result => {
  if (!result.ok) {
    setStatus("hostReveal", result.error, true);
    if (label === "start" && /^Insufficient /i.test(result.error || "")) askDialog({ title: "Not enough questions", body: result.error });
  }
});
$("startGame").onclick = hostAction("host:start", "start");
$("reveal").onclick = hostAction("host:reveal");
$("next").onclick = hostAction("host:next");
$("pauseGame").onclick = hostAction("host:pause");
$("skipTurn").onclick = hostAction("host:skip-turn");

// Host keyboard shortcuts (handy with a wireless keyboard by the TV).
document.addEventListener("keydown", e => {
  if (role !== "host" || !state || !$("dialog").hidden || !$("statsModal").hidden) return;
  if (e.target.closest("input, textarea, select, [contenteditable]")) return;
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  const press = id => { const b = $(id); if (b && !b.hidden && !b.disabled) { b.click(); pulse(b); } };
  if (e.code === "Space" || e.key === "Enter" || e.key === "ArrowRight") {
    e.preventDefault();
    if (document.activeElement?.tagName === "BUTTON") document.activeElement.blur();
    const order = ["reveal", "next", "startGame"];
    const target = order.find(id => !$(id).hidden && !$(id).disabled);
    if (target) press(target);
  } else if (e.key.toLowerCase() === "p") press("pauseGame");
  else if (e.key.toLowerCase() === "s") press("skipTurn");
});
function pulse(el) { el.classList.remove("pressed"); void el.offsetWidth; el.classList.add("pressed"); }

const submitJoin = () => {
  const code = $("joinCode").value.trim().toUpperCase();
  const name = $("playerName").value.trim();
  if (!code) { setStatus("joinStatus", "Enter the room code from the TV.", true); $("joinCode").focus(); return; }
  if (!name) { setStatus("joinStatus", "Enter your name.", true); $("playerName").focus(); return; }
  playerGameCode = code;
  sessionStorage.setItem("tpPlayerGameCode", code);
  sessionStorage.setItem("tpPlayerName", name);
  localStorage.setItem("tpPlayerGameCode", code);
  localStorage.setItem("tpPlayerName", name);
  $("joinGame").disabled = true;
  connectPlayer(code, name, null);
};
$("joinGame").onclick = submitJoin;
$("joinCode").addEventListener("input", e => { e.target.value = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ""); });
[$("joinCode"), $("playerName")].forEach(el => el.addEventListener("keydown", e => { if (e.key === "Enter") submitJoin(); }));

function connectHost(code, token) {
  socket.emit("host:create", { code, hostToken: token }, result => {
    if (!result.ok) {
      // Stale host credentials: forget them so the Create button works cleanly.
      if (!state) {
        sessionStorage.removeItem("tpHostToken"); localStorage.removeItem("tpHostToken");
        sessionStorage.removeItem("tpHostGameCode"); localStorage.removeItem("tpHostGameCode");
        hostToken = null; hostGameCode = null;
      }
      return setStatus("hostStatus", result.error, true);
    }
    acceptState(result.state);
    $("hostCode").textContent = code;
    render();
  });
}

function connectPlayer(code, name, reconnectToken) {
  socket.emit("player:join", { code, name, reconnectToken }, result => {
    $("joinGame").disabled = false;
    if (!result.ok) return setStatus("joinStatus", result.error, true);
    myPlayerId = result.playerId;
    playerReconnectToken = result.reconnectToken;
    playerGameCode = code;
    sessionStorage.setItem("tpPlayerId", myPlayerId);
    sessionStorage.setItem("tpPlayerReconnectToken", playerReconnectToken);
    sessionStorage.setItem("tpPlayerGameCode", code);
    localStorage.setItem("tpPlayerId", myPlayerId);
    localStorage.setItem("tpPlayerReconnectToken", playerReconnectToken);
    localStorage.setItem("tpPlayerGameCode", code);
    if (name) {
      sessionStorage.setItem("tpPlayerName", name);
      localStorage.setItem("tpPlayerName", name);
    }
    acceptState(result.state);
    $("joinStatus").hidden = true;
    if (result.reconnected) toast("Reconnected to the game.", "ok");
    vibrate(30);
    render();
  });
}

function acceptState(next) {
  if (next?.serverNow) clockOffset = next.serverNow - Date.now();
  state = next;
}

socket.on("connect", () => {
  setConnectionBadge(true);
  if (hostToken && hostGameCode) connectHost(hostGameCode, hostToken);
  else if (playerReconnectToken && playerGameCode) connectPlayer(playerGameCode, sessionStorage.getItem("tpPlayerName") || localStorage.getItem("tpPlayerName") || "", playerReconnectToken);
});

socket.on("disconnect", () => { setConnectionBadge(false); });
socket.on("player:removed", info => {
  for (const k of ["tpPlayerId", "tpPlayerReconnectToken", "tpPlayerGameCode"]) { sessionStorage.removeItem(k); localStorage.removeItem(k); }
  myPlayerId = null;
  playerReconnectToken = null;
  playerGameCode = null;
  state = null;
  previousVisualState = null;
  setStatus("joinStatus", info?.message || "You were removed from the lobby.", true);
  render();
});

socket.on("state", next => { acceptState(next); render(); });
socket.on("wedge:play", ({ awards = [] } = {}) => {
  if (role !== "host" || !awards.length) return;
  queueWedgeAwards(awards);
  playNextWedgeAward();
});
socket.on("answerCount", info => {
  if (role !== "host") return;
  answerCount = info;
  renderAnswerProgress();
});
let answerCount = null;

function setConnectionBadge(connected) {
  const el = $("connectionBadge");
  el.textContent = connected ? "Connected" : "Reconnecting…";
  el.classList.toggle("offline", !connected);
}

function setStatus(id, message, error = false) {
  if (id === "hostStatus" && !$("hostControls").hidden) { toast(message, error ? "error" : "info"); return; }
  const el = $(id);
  if (!el) return;
  el.hidden = false;
  el.textContent = message;
  el.classList.toggle("error", error);
  el.classList.toggle("ok", !error);
}

/* ------------------------------------------------------------------ *
 * Timer: one rAF loop drives every countdown with server clock offset.
 * ------------------------------------------------------------------ */
function timerActive() { return !!(state?.timerEndsAt && !state.revealed && state.stage === "answering" && !state.paused); }
function timerRemainingMs() {
  if (state?.paused && state.stage === "answering") return state.pausedTimerMs || 0;
  if (!timerActive()) return 0;
  return Math.max(0, state.timerEndsAt - serverNow());
}
function timerText() {
  if (state?.paused && state.stage === "answering") return `${Math.max(1, Math.ceil((state.pausedTimerMs || 0) / 1000))}`;
  if (!timerActive()) return "";
  return `${Math.ceil(timerRemainingMs() / 1000)}`;
}
const RING_LEN = 2 * Math.PI * 20;
let lastTimerSecond = null;
function tickTimer() {
  const visible = timerActive() || (state?.paused && state?.stage === "answering");
  const remaining = timerRemainingMs();
  const total = state?.timerTotalMs || 30000;
  const progress = visible ? Math.max(0, Math.min(1, remaining / total)) : 0;
  const seconds = Math.ceil(remaining / 1000);
  const critical = timerActive() && seconds > 0 && seconds <= 5;
  document.body.classList.toggle("timer-critical", critical);
  document.body.classList.toggle("timer-paused", !!(state?.paused && state?.stage === "answering"));
  document.querySelectorAll("[data-timer]").forEach(el => {
    el.classList.toggle("idle", !visible);
    const ring = el.querySelector(".ring-fill");
    if (ring) ring.style.strokeDashoffset = String(RING_LEN * (1 - progress));
    const bar = el.querySelector(".bar-fill");
    if (bar) bar.style.transform = `scaleX(${progress})`;
    const txt = el.querySelector("[data-timer-text]");
    if (txt) { const t = timerText(); if (txt.textContent !== t) txt.textContent = t; }
  });
  if (critical && seconds !== lastTimerSecond) {
    playTone("tick");
    if (role === "player") vibrate(15);
  }
  lastTimerSecond = critical ? seconds : null;
  requestAnimationFrame(tickTimer);
}
requestAnimationFrame(tickTimer);

function timerRingHTML() {
  return `<div class="timer-ring idle" data-timer aria-label="Time remaining"><svg viewBox="0 0 44 44"><circle class="ring-track" cx="22" cy="22" r="20"></circle><circle class="ring-fill" cx="22" cy="22" r="20" style="stroke-dasharray:${RING_LEN.toFixed(2)}"></circle></svg><span data-timer-text data-live></span></div>`;
}
function timerBarHTML() {
  return `<div class="timer-bar idle" data-timer><div class="bar-fill"></div><span class="bar-text" data-timer-text data-live></span></div>`;
}

/* ------------------------------------------------------------------ *
 * Main render
 * ------------------------------------------------------------------ */
function render() {
  document.body.classList.toggle("has-game", !!state);
  if (!state) {
    $("joinPanel").hidden = false;
    $("playerGame").hidden = true;
    return;
  }
  const previous = previousVisualState;
  renderHost();
  renderPlayer();
  updateVisualTransitions(previous, state);
  previousVisualState = snapshotVisualState(state);
  runCounters();
}

function snapshotVisualState(s) {
  if (!s) return null;
  return {
    round: s.round,
    question: s.question?.id || null,
    questionIndex: s.questionIndex,
    revealed: s.revealed,
    finalCategoryName: s.finalCategoryName,
    status: s.status,
    winnerId: s.winnerId,
    notice: s.notice,
    selectionNotice: s.selectionNotice,
    stage: s.stage,
    turnPlayerId: s.turnPlayerId,
    categoryPickerId: s.stage === "last-category" ? s.finalQuestionPicker?.playerId : (s.round === "Switchagories" && !s.question ? s.turnPlayerId : null),
    wedgeAwards: (s.wedgeAwards || []).map(a => ({ id:a.id, playerId:a.playerId, playerName:a.playerName, color:a.color })),
    scores: (s.scores || []).map(p => ({ id:p.id, score:p.score, wedges:(p.wedges || []).length, wedgesList:(p.wedges || []) }))
  };
}

function updateVisualTransitions(prev, next) {
  if (!prev || !next) return;
  if (next.question?.id !== prev.question || next.stage !== prev.stage) answerCount = null;

  // Wedge awards are recorded in the game state immediately, but the host
  // explicitly releases their visual animation with the Next button.
  if (next.status === "finished" && prev.status !== "finished") {
    clearTimeout(finalOptionsTimer);
    const finishCelebration = () => {
      showTransition("Game over", next.winnerName || "Winner", "takes the game", 2000, null, "win");
      celebrateWinner();
    };
    if (role === "host" && (wedgeAwardPlaying || wedgeAwardQueue.length)) queueAfterWedgeAwards(finishCelebration);
    else finishCelebration();
    return;
  }

  // Player feedback for their own turn in turn-based rounds.
  if (role === "player" && next.turnPlayerId === myPlayerId && prev.turnPlayerId !== myPlayerId && next.stage === "answering" && ["Grab Bag", "Close Call"].includes(next.round)) {
    vibrate([40, 60, 40]);
    playTone("turn");
  }

  const categoryPick = next.stage === "last-category" || (next.round === "Switchagories" && !next.question && next.stage !== "round-intro");
  const pickerId = next.stage === "last-category" ? next.finalQuestionPicker?.playerId : (next.round === "Switchagories" && !next.question ? next.turnPlayerId : null);
  if (categoryPick && pickerId && (prev.categoryPickerId !== pickerId || prev.stage !== next.stage || prev.question !== (next.question?.id || null) || prev.round !== next.round)) {
    if (role === "host") {
      const picker = state.players?.find(p => p.id === pickerId);
      showTransition("Category pick", `${picker?.name || next.turnPlayerName || "Player"}, pick a category`, "", 1800);
    } else if (role === "player" && myPlayerId === pickerId) {
      showTransition("Your pick", "Choose a category", "", 1600);
      vibrate([40, 60, 40]);
    }
    return;
  }
  if (next.round === "Final Round" && next.finalCategoryName !== prev.finalCategoryName && next.finalCategoryName) {
    clearTimeout(finalOptionsTimer);
    const color = categoryInfo(next.finalCategoryName).color;
    showTransition("Final round", next.finalCategoryName, `Category ${(next.finalCategoryIndex ?? 0) + 1} of ${next.finalCategoryCount}`, 1500, color);
    playTone("transition");
    const choices = next.question?.options || [];
    if (choices.length >= 2) {
      finalOptionsTimer = setTimeout(() => {
        showTransition("This category's choices", `${choices[0]} or ${choices[1]}`, "The same two choices apply to all five questions", 2600, color);
        playTone("transition");
      }, 1600);
    }
    return;
  }
  if (next.round !== prev.round && next.round) {
    showTransition("Next round", next.round, "Get ready", 1300);
    playTone("transition");
    return;
  }
  if (next.question && next.question.id !== prev.question) playTone("question");
  if (next.stage === "answering" && prev.stage !== "answering") playTone("go");
  if (next.revealed && !prev.revealed) {
    playTone("reveal");
    if (role === "player") revealFeedback(next);
  }
  if (next.selectionNotice && next.selectionNotice !== prev.selectionNotice) showSelectionDialog(next.selectionNotice);
}

function revealFeedback(s) {
  const mine = (s.answerSelections || []).filter(a => a.playerId === myPlayerId);
  if (!mine.length || !["Quickstarter", "Switchagories", "Final Round"].includes(s.round)) return;
  const right = mine.some(a => a.value === s.answer);
  vibrate(right ? [30, 40, 30] : 120);
  document.body.classList.remove("flash-right", "flash-wrong");
  void document.body.offsetWidth;
  document.body.classList.add(right ? "flash-right" : "flash-wrong");
  setTimeout(() => document.body.classList.remove("flash-right", "flash-wrong"), 900);
}

function showTransition(kicker, title, subtitle, ms = 1200, accentColor = null, variant = "") {
  const overlay = $("transitionOverlay");
  if (!overlay) return;
  $("transitionKicker").textContent = kicker;
  $("transitionTitle").textContent = title;
  $("transitionSubtitle").textContent = subtitle;
  $("transitionSubtitle").hidden = !subtitle;
  overlay.style.setProperty("--transition-accent", accentColor ? colorValue(accentColor) : "#ffcc4d");
  overlay.classList.toggle("has-accent", !!accentColor);
  overlay.dataset.variant = variant;
  overlay.hidden = false;
  overlay.classList.remove("show", "leaving");
  void overlay.offsetWidth;
  overlay.classList.add("show");
  clearTimeout(transitionTimer);
  transitionTimer = setTimeout(() => {
    overlay.classList.add("leaving");
    overlay.classList.remove("show");
    setTimeout(() => { if (!overlay.classList.contains("show")) overlay.hidden = true; }, 360);
  }, ms);
}

function highlightPlayer(playerId) {
  document.querySelectorAll(".tv-player").forEach(el => {
    if (el.dataset.key === `p-${playerId}`) {
      el.classList.remove("wedge-award");
      void el.offsetWidth;
      el.classList.add("wedge-award");
      setTimeout(() => el.classList.remove("wedge-award"), 1100);
    }
  });
}

const wedgeAwardQueue = [];
let wedgeAwardPlaying = false;
const postWedgeCallbacks = [];

function queueAfterWedgeAwards(callback) {
  if (typeof callback !== "function") return;
  postWedgeCallbacks.push(callback);
  playNextWedgeAward();
}

function finishWedgeQueueIfIdle() {
  if (wedgeAwardPlaying || wedgeAwardQueue.length) return;
  while (postWedgeCallbacks.length) {
    const callback = postWedgeCallbacks.shift();
    try { callback(); } catch {}
  }
}

function queueWedgeAwards(awards) {
  const existing = new Set(wedgeAwardQueue.map(a => a.id));
  awards.forEach(award => {
    if (existing.has(award.id)) return;
    wedgeAwardQueue.push(award);
    existing.add(award.id);
  });
}

function playNextWedgeAward() {
  if (wedgeAwardPlaying || !wedgeAwardQueue.length) {
    finishWedgeQueueIfIdle();
    return;
  }
  wedgeAwardPlaying = true;
  const award = wedgeAwardQueue.shift();
  showWedgeAward(award, () => {
    wedgeAwardPlaying = false;
    highlightPlayer(award.playerId);
    if (wedgeAwardQueue.length) {
      playNextWedgeAward();
    } else {
      // Tell the server the visual wedge sequence is finished, but do not
      // advance the game. The host must press Next a second time.
      if (role === "host") socket.emit("host:wedge-animation-complete", {}, () => {});
      finishWedgeQueueIfIdle();
    }
  });
}

function showWedgeAward(award, onDone) {
  const overlay = $("wedgeAwardOverlay");
  if (!overlay) { onDone?.(); return; }
  const info = categoryInfo(award.color);
  const color = colorValue(info.color || award.color);
  const player = state?.players?.find(p => p.id === award.playerId);
  const wedges = [...(player?.wedges || [])];
  const has = wedges.some(w => colorValue(categoryInfo(w).color || w).toLowerCase() === color.toLowerCase());
  if (!has) wedges.push(award.color);
  let slot = wedgeSlots(wedges).findIndex(w => w && colorValue(categoryInfo(w).color || w).toLowerCase() === color.toLowerCase());
  if (slot < 0) slot = categoryIndexFor(award.color);
  $("wedgeAwardName").textContent = award.playerName || player?.name || "Player";
  $("wedgeAwardCategory").textContent = info.name && info.name !== award.color ? `${info.name} wedge · ${wedges.length} of 6` : `${wedges.length} of 6 wedges`;
  $("wedgeAwardVisual").innerHTML = wedgeCircleHTML(wedges, { highlight: slot, cls: "award-pie" });
  overlay.style.setProperty("--award-color", color);
  overlay.hidden = false;
  overlay.classList.remove("show");
  void overlay.offsetWidth;
  overlay.classList.add("show");
  playWedgeFanfare();
  burstConfetti(36, [color, "#ffffff", "#ffcc4d"]);
  clearTimeout(window.__wedgeAwardTimer);
  window.__wedgeAwardTimer = setTimeout(() => {
    overlay.classList.remove("show");
    setTimeout(() => {
      overlay.hidden = true;
      onDone?.();
    }, 260);
  }, 2100);
}

function playWedgeFanfare() {
  try {
    audioContext ||= new (window.AudioContext || window.webkitAudioContext)();
    const ctx = audioContext;
    if (ctx.state === "suspended") ctx.resume().catch(() => {});
    const now = ctx.currentTime;
    const notes = [523.25, 659.25, 783.99, 1046.5, 1318.51];
    notes.forEach((freq, i) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = i === notes.length - 1 ? "triangle" : "sine";
      osc.frequency.value = freq;
      const start = now + i * 0.13;
      gain.gain.setValueAtTime(0.0001, start);
      gain.gain.exponentialRampToValueAtTime(i === notes.length - 1 ? 0.12 : 0.08, start + 0.025);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.42);
      osc.connect(gain).connect(ctx.destination);
      osc.start(start);
      osc.stop(start + 0.46);
    });
  } catch {}
}

function showSelectionDialog(message) {
  const dialog = $("selectionDialog");
  if (!dialog) return;
  $("selectionDialogText").textContent = message;
  dialog.hidden = false;
  dialog.classList.remove("show");
  void dialog.offsetWidth;
  dialog.classList.add("show");
  clearTimeout(window.__selectionDialogTimer);
  window.__selectionDialogTimer = setTimeout(() => {
    dialog.classList.remove("show");
    setTimeout(() => { dialog.hidden = true; }, 260);
  }, 4500);
}

function burstConfetti(count, colors) {
  if (reduceMotion) return;
  const frag = document.createDocumentFragment();
  for (let i = 0; i < count; i++) {
    const el = document.createElement("i");
    el.className = "confetti-piece";
    const dur = 2.4 + Math.random() * 2.2;
    el.style.setProperty("--left", `${Math.random() * 100}vw`);
    el.style.setProperty("--fall", `${dur}s`);
    el.style.setProperty("--delay", `${Math.random() * 0.5}s`);
    el.style.setProperty("--drift", `${(Math.random() - 0.5) * 30}vw`);
    el.style.setProperty("--spin", `${(Math.random() > 0.5 ? 1 : -1) * (360 + Math.random() * 720)}deg`);
    el.style.setProperty("--confetti-color", colors[i % colors.length]);
    if (i % 3 === 0) el.classList.add("round");
    frag.appendChild(el);
    setTimeout(() => el.remove(), (dur + 0.6) * 1000);
  }
  document.body.appendChild(frag);
}

function celebrateWinner() {
  burstConfetti(window.innerWidth < 700 ? 60 : 120, ["#e85aa8", "#f28c28", "#e7c83b", "#43a86b", "#4d82d9", "#8b5bc7"]);
  playTone("win");
}

function playTone(kind) {
  try {
    audioContext ||= new (window.AudioContext || window.webkitAudioContext)();
    const ctx = audioContext;
    if (ctx.state === "suspended") return;
    const tones = { question:[520,.08,.04], reveal:[700,.12,.05], transition:[420,.16,.045], wedge:[880,.16,.05], win:[660,.3,.05], tick:[980,.05,.025], go:[620,.1,.04], turn:[760,.14,.05] };
    const [freq, duration, vol] = tones[kind] || tones.question;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.frequency.value = freq;
    osc.type = "sine";
    gain.gain.setValueAtTime(0.0001, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(vol, ctx.currentTime + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + duration);
    osc.connect(gain).connect(ctx.destination);
    osc.start(); osc.stop(ctx.currentTime + duration + 0.02);
  } catch {}
}
// Browsers only allow audio after a user gesture.
document.addEventListener("pointerdown", () => {
  try { audioContext ||= new (window.AudioContext || window.webkitAudioContext)(); if (audioContext.state === "suspended") audioContext.resume(); } catch {}
}, { once: false, passive: true });

/* ------------------------------------------------------------------ *
 * Shared markup
 * ------------------------------------------------------------------ */
function roundName() {
  if (state.status === "finished") return "Game over";
  if (state.status === "lobby") return "Lobby";
  return state.round || "Lobby";
}

function questionProgress() {
  if (!state.question || !state.questionCount) return "";
  return `Question ${state.questionIndex + 1} of ${state.questionCount}`;
}

function stageCard(kind, title, subtitle = "", color = null, key = "") {
  const cls = kind === "round" ? "stage-card round-stage" : kind === "category" ? "stage-card category-stage" : "stage-card question-stage";
  const style = color ? ` style="--category-color:${esc(colorValue(color))}"` : "";
  const kicker = kind === "round" ? "Next round" : kind === "category" ? "Category" : "";
  const icon = kind === "category" ? `<div class="stage-wedge"></div>` : "";
  return `<div class="${cls}"${style} data-key="stage-${esc(kind)}-${esc(key || title)}"><div class="stage-inner">${icon}${kicker ? `<div class="stage-kicker">${kicker}</div>` : ""}<div class="stage-title">${esc(title)}</div>${subtitle ? `<div class="stage-subtitle">${esc(subtitle)}</div>` : ""}</div></div>`;
}

function categoryBanner(info) {
  return `<div class="category-banner" style="--category-color:${esc(colorValue(info.color))}"><span class="banner-dot"></span><span class="banner-name">${esc(info.name)}</span></div>`;
}

function categoryChoicesHTML(choices, { buttons = false, attr = "", disabled = false } = {}) {
  return choices.map((c, i) => {
    const style = `style="--category-color:${esc(colorValue(c.color))}"`;
    const inner = `<span class="choice-wedge"></span><span class="choice-name">${esc(c.name)}</span>`;
    return buttons
      ? `<button class="answer category-choice" ${style} data-key="cat-${i}-${esc(c.name)}" ${attr}="${esc(c.name)}" ${disabled ? "disabled" : ""}>${inner}</button>`
      : `<div class="answer static-answer category-choice" ${style} data-key="cat-${i}-${esc(c.name)}">${inner}</div>`;
  }).join("");
}

function closeCallOrderHTML() {
  return `<div class="close-call-reveal"><strong>Correct order</strong><ol class="close-call-order">${state.answer.map(a => { const oi = state.question.options.indexOf(a); const v = state.answerValues?.[oi]; return `<li><span>${esc(a)}</span>${v !== undefined && v !== "" ? `<em>${esc(v)}</em>` : ""}</li>`; }).join("")}</ol></div>`;
}

/* ------------------------------------------------------------------ *
 * Host
 * ------------------------------------------------------------------ */
function renderHost() {
  const lobby = state.status === "lobby";
  $("hostHero").hidden = true;
  $("hostControls").hidden = false;
  document.body.dataset.status = state.status || "";
  $("hostCode").textContent = roomCodeHidden ? "••••••" : state.code;
  $("toggleRoomCode").textContent = roomCodeHidden ? "Show code" : "Hide code";
  $("gameStage").dataset.stage = state.stage || "";
  $("gameStage").dataset.round = state.round || "";

  // Scoreboard strip
  const ranked = (state.scores || []).slice().sort((a, b) => b.wedges.length - a.wedges.length || b.score - a.score);
  patch($("hostPlayers"), state.players.length
    ? state.players.map(p => {
        const turn = state.turnPlayerId === p.id && state.status === "playing";
        const rank = ranked.findIndex(r => r.id === p.id) + 1;
        return `<div class="tv-player${turn ? " current" : ""}${p.connected ? "" : " offline"}" data-key="p-${esc(p.id)}" data-score-host>
          <div class="score-wedge-circle">${wedgeCircleHTML(p.wedges || [])}</div>
          <div class="tv-player-info"><div class="tv-player-name">${esc(p.name)}</div>
          <div class="tv-player-score"><span data-score="${p.score}" data-live></span> <small>pts</small></div></div>
          ${!lobby && rank === 1 && p.score > 0 ? `<span class="leader-badge" title="Leader">1st</span>` : ""}
          ${turn ? `<span class="turn-badge">Turn</span>` : ""}
          ${p.connected ? "" : '<span class="tv-player-offline">Offline</span>'}
          ${lobby ? `<button class="remove-player-btn" data-remove-player="${esc(p.id)}" aria-label="Remove ${esc(p.name)}" title="Remove player">×</button>` : ""}
        </div>`;
      }).join("")
    : `<div class="tv-empty" data-key="empty">Players appear here as they join.</div>`);
  document.querySelectorAll("[data-remove-player]").forEach(btn => btn.onclick = async () => {
    const name = state.players.find(p => p.id === btn.dataset.removePlayer)?.name || "this player";
    const ok = await askDialog({ title: `Remove ${name}?`, body: "They'll be sent back to the join screen.", actions: [{ label: "Cancel", value: false, kind: "ghost" }, { label: "Remove", value: true, kind: "danger" }], dismissValue: false });
    if (!ok) return;
    socket.emit("host:remove-player", { playerId: btn.dataset.removePlayer }, result => {
      if (!result.ok) setStatus("hostStatus", result.error, true);
    });
  });

  // Setup panels only matter in the lobby.
  $("workbookPanel").hidden = !lobby;
  $("categoriesPanel").hidden = !lobby;
  patch($("categoryEditor"), state.categories.map(c =>
    `<div class="category" data-color="${esc(c.color)}" data-key="c-${esc(c.color)}"><span class="swatch" style="background:${esc(colorValue(c.color))}" title="${esc(c.color)}"></span><input value="${esc(c.name)}" aria-label="${esc(c.color)} category name"></div>`).join(""));

  // Action dock
  const playing = state.status === "playing";
  const finished = state.status === "finished";
  const show = (id, visible) => { $(id).hidden = !visible; };
  show("startGame", lobby);
  show("reveal", playing);
  show("next", playing);
  show("pauseGame", playing);
  show("skipTurn", playing && ["Grab Bag", "Close Call", "Switchagories"].includes(state.round));
  show("showStats", finished);
  show("newGame", finished);
  show("playAgain", finished);
  $("startGame").disabled = !lobby || !state.questionSetLoaded || !state.players.length;
  $("startGame").title = !state.questionSetLoaded ? "Upload a workbook first" : !state.players.length ? "Wait for players to join" : "";
  $("pauseGame").disabled = !playing || state.stage === "wedge-award";
  $("pauseGame").textContent = state.paused ? "Resume" : "Pause";
  $("reveal").disabled = state.paused || !playing || state.revealed || state.stage !== "answering";
  $("next").disabled = state.paused || !playing || state.stage === "switch-category" || state.stage === "last-category" || state.stage === "category-preview" || (state.stage === "wedge-award" && state.wedgePlaybackPending !== false) || (state.stage === "answering" && !state.revealed);
  $("skipTurn").disabled = state.paused || !playing || state.revealed || !["Grab Bag","Close Call","Switchagories"].includes(state.round);
  $("reveal").classList.toggle("primary", !$("reveal").disabled);
  $("next").classList.toggle("primary", !$("next").disabled);
  $("pauseGame").classList.toggle("primary", !!state.paused);
  $("kbdHint").hidden = !playing;

  // Round header
  const meta = hostRoundMeta();
  patch($("hostRound"), `<div class="round-head"><div class="round-left"><div class="round-title">${esc(roundName())}</div>${meta ? `<div class="round-meta">${meta}</div>` : ""}</div>${playing ? timerRingHTML() : ""}</div>`);

  $("hostReveal").classList.remove("error", "ok");
  $("hostAnswers").className = "answers";

  if (state.paused) {
    $("gameStage").classList.add("paused");
  } else $("gameStage").classList.remove("paused");

  if (finished) {
    patch($("hostQuestion"), winnerCard(true));
    patch($("hostAnswers"), "");
    setHostStatus(state.notice || "");
    renderScores();
    return;
  }

  if (lobby) {
    patch($("hostQuestion"), lobbyCard());
    patch($("hostAnswers"), "");
    setHostStatus(!state.questionSetLoaded ? "Upload and validate a question workbook to enable Start game." : !state.players.length ? "Waiting for players to join." : `${state.players.length} player${state.players.length === 1 ? "" : "s"} ready. Press Start game when everyone's in.`);
    renderScores();
    return;
  }

  if (state.stage === "round-intro") {
    const title = state.round || "Round";
    const finalInfo = state.round === "Final Round" && state.finalCategoryName ? categoryInfo(state.finalCategoryName) : null;
    patch($("hostQuestion"), stageCard("round", title, finalInfo ? finalInfo.name : "", finalInfo?.color, `${state.round}-${state.finalCategoryIndex ?? ""}`));
    patch($("hostAnswers"), "");
    setHostStatus(pausedText() || "Press Next to begin this round.");
    renderScores();
    return;
  }

  if (state.stage === "last-category" && state.finalQuestionPicker) {
    const picker = state.players.find(p => p.id === state.finalQuestionPicker.playerId);
    const choices = state.finalQuestionPicker.choices || [];
    patch($("hostQuestion"), `<div class="pick-prompt" data-key="pick-last-${esc(picker?.id)}"><div class="question">${esc(picker?.name || "The last-place player")} is choosing the category for the final question</div></div>`);
    $("hostAnswers").className = "answers category-grid";
    patch($("hostAnswers"), categoryChoicesHTML(choices));
    setHostStatus(pausedText() || "Waiting for a category choice.");
    renderScores();
    return;
  }

  if (state.round === "Switchagories" && !state.question) {
    const choices = state.switchagoriesCategoryChoices || [];
    patch($("hostQuestion"), `<div class="pick-prompt" data-key="pick-sw-${esc(state.turnPlayerId)}-${choices.map(c => c.name).join("|")}"><div class="question">${state.turnPlayerName ? `${esc(state.turnPlayerName)} is choosing a category` : "Choosing a category"}</div></div>`);
    $("hostAnswers").className = "answers category-grid";
    patch($("hostAnswers"), categoryChoicesHTML(choices));
    setHostStatus(pausedText() || "Waiting for a category choice.");
    renderScores();
    return;
  }

  if (!state.question) {
    patch($("hostQuestion"), `<div class="empty-card" data-key="empty"><strong>${esc(state.notice || "Get ready")}</strong></div>`);
    patch($("hostAnswers"), "");
    setHostStatus(pausedText() || state.notice || "Press Next to continue.");
    renderScores();
    return;
  }

  const info = categoryInfo(state.question.category);
  const qid = state.question.id;
  if (state.stage === "category-preview") {
    patch($("hostQuestion"), stageCard("category", info.name, "", info.color, `cat-${qid}`));
    patch($("hostAnswers"), "");
    setHostStatus(pausedText() || "The question is coming up.");
    renderScores();
    return;
  }
  if (state.stage === "question-preview") {
    patch($("hostQuestion"), `<div class="question-block preview" data-key="q-${esc(qid)}" style="--category-color:${esc(colorValue(info.color))}">${categoryBanner(info)}<div class="question">${esc(state.question.question)}</div></div>`);
    patch($("hostAnswers"), "");
    setHostStatus(pausedText() || "Read the question aloud, then press Next to start the timer.");
    renderScores();
    return;
  }

  patch($("hostQuestion"), `<div class="question-block" data-key="q-${esc(qid)}" style="--category-color:${esc(colorValue(info.color))}">${categoryBanner(info)}<div class="question">${esc(state.question.question)}</div></div>`);
  const selections = state.answerSelections || [];
  const selectionFor = value => selections.filter(a => a.value === value);
  const optionStateClass = value => {
    const picked = selectionFor(value);
    if (state.round === "Grab Bag") {
      if (state.revealed) return state.answer?.includes(value) ? "selected-correct" : (picked.length ? "selected-wrong" : "dim-wrong");
      if (!picked.length) return "";
      return picked[0].correct ? "selected-correct" : "selected-wrong";
    }
    if (state.round === "Close Call") {
      if (!picked.length) return "";
      return state.revealed ? "close-call-picked" : "selected-gray";
    }
    // Quickstarter, Switchagories, and Final Round: after reveal the correct
    // answer turns green and the rest red. Before reveal picks are gray.
    if (!state.revealed) return picked.length ? "selected-gray" : "";
    if (value === state.answer) return "selected-correct";
    return picked.length ? "selected-wrong" : "dim-wrong";
  };
  const optionPlayers = value => selectionFor(value).map(a => `<span class="answer-picker" data-key="pk-${esc(a.playerId)}">${esc(a.playerName)}</span>`).join("");
  const grab = state.round === "Grab Bag";
  $("hostAnswers").className = "answers" + (grab ? " grab-grid" : "") + (state.revealed ? " is-revealed" : "");
  patch($("hostAnswers"), state.question.options.map((x, i) => {
    const picked = selectionFor(x);
    const val = state.round === "Close Call" && state.revealed ? (state.answerValues?.[i] ?? "") : "";
    let rank = "";
    if (state.round === "Close Call" && state.revealed && Array.isArray(state.answer)) {
      const r = state.answer.indexOf(x) + 1;
      if (r) rank = `<span class="close-call-rank">#${r}</span>`;
    }
    return `<div class="answer static-answer ${optionStateClass(x)}" data-key="a-${esc(qid)}-${i}" style="--i:${i}"><span class="answer-key">${LETTERS[i] || ""}</span><span class="answer-text">${esc(x)}${val !== "" ? ` <strong class="close-call-value">${esc(val)}</strong>` : ""}</span>${rank}${picked.length ? `<div class="answer-pickers">${optionPlayers(x)}</div>` : ""}</div>`;
  }).join(""));

  if (state.round === "Close Call" && state.revealed && Array.isArray(state.answer)) {
    patch($("hostReveal"), closeCallOrderHTML());
    $("hostReveal").classList.add("ok");
  } else if (state.revealed) {
    patch($("hostReveal"), `<div class="reveal-line">${formatAnswer(state)}</div>`);
    $("hostReveal").classList.add("ok");
  } else if (state.paused) {
    setHostStatus(pausedText());
  } else {
    const waiting = state.notice || (state.turnPlayerName && ["Grab Bag", "Close Call"].includes(state.round) ? `Waiting for ${state.turnPlayerName}` : "Collecting answers");
    patch($("hostReveal"), `<div class="answer-progress"><span>${esc(waiting)}</span><span id="answerProgress" class="answer-dots"></span></div>`);
    renderAnswerProgress();
  }
  renderScores();
}

function pausedText() { return state.paused ? "Game paused — press Resume when everyone's ready." : ""; }

function setHostStatus(text) {
  patch($("hostReveal"), text ? `<div class="reveal-line muted-line">${esc(text)}</div>` : "");
}

function renderAnswerProgress() {
  const el = $("answerProgress");
  if (!el || !state) return;
  const simultaneous = ["Quickstarter", "Switchagories", "Final Round"].includes(state.round);
  if (!simultaneous) { el.innerHTML = ""; return; }
  const answeredIds = new Set((state.answerSelections || []).map(a => a.playerId));
  const eliminated = new Set(state.round === "Final Round" ? (state.eliminatedPlayerIds || []) : []);
  const eligible = state.players.filter(p => !eliminated.has(p.id));
  const total = answerCount?.total ?? eligible.length;
  const answered = Math.max(answerCount?.answered ?? 0, eligible.filter(p => answeredIds.has(p.id)).length);
  patch(el, `${Array.from({ length: total }, (_, i) => `<i class="${i < answered ? "on" : ""}"></i>`).join("")}<b>${answered}/${total} answered</b>`);
}

function hostRoundMeta() {
  if (state.status === "lobby") return `<span>${state.questionSetLoaded ? "Questions loaded" : "No questions loaded yet"}</span>`;
  if (state.status === "finished") return "";
  const parts = [];
  if (state.round === "Final Round") {
    parts.push(`Category ${(state.finalCategoryIndex ?? 0) + 1} of ${state.finalCategoryCount}`);
    if (state.finalCategoryResolved) parts.push("Category complete");
  } else if (state.round === "Switchagories") {
    parts.push("Two category picks each");
  }
  const qp = questionProgress();
  if (qp) parts.push(qp);
  if (state.turnPlayerName && ["Grab Bag", "Close Call", "Switchagories"].includes(state.round)) parts.push(`${state.turnPlayerName}'s turn`);
  return parts.map(p => `<span>${esc(p)}</span>`).join("") + (state.paused ? `<span><b class="paused-tag">Paused</b></span>` : "");
}

function lobbyCard() {
  const url = `${location.host}`;
  const code = roomCodeHidden ? "••••••" : state.code;
  return `<div class="lobby-card" data-key="lobby"><div class="lobby-join"><div class="lobby-step">Join on your phone at</div><div class="lobby-url">${esc(url)}</div><div class="lobby-step">with room code</div><div class="lobby-code${roomCodeHidden ? " hidden-code" : ""}">${[...code].map((ch, i) => `<span style="--i:${i}">${esc(ch)}</span>`).join("")}</div></div>
    <div class="lobby-count"><span data-key="cnt-${state.players.length}">${state.players.length}</span> ${state.players.length === 1 ? "player" : "players"} in</div></div>`;
}

function winnerCard(host) {
  const winner = state.players.find(p => p.id === state.winnerId);
  const ranked = (state.scores || []).slice().sort((a, b) => b.wedges.length - a.wedges.length || b.score - a.score);
  const isMe = !host && state.winnerId === myPlayerId;
  return `<div class="winner-card" data-key="winner-${esc(state.winnerId)}">
    ${winner ? `<div class="winner-wedges">${wedgeCircleHTML(winner.wedges || [], { cls: "winner-pie" })}</div>` : ""}
    <div class="winner-kicker">${isMe ? "You win!" : "Winner"}</div>
    <div class="winner-name">${esc(state.winnerName || "Winner")}</div>
    ${winner ? `<div class="winner-sub">${winner.wedges?.length || 0} of 6 wedges · ${winner.score.toLocaleString()} points</div>` : ""}
    ${host && ranked.length > 1 ? `<ol class="final-standings">${ranked.map((p, i) => `<li style="--i:${i}" class="${p.id === state.winnerId ? "is-winner" : ""}"><span class="fs-name">${esc(p.name)}</span><span class="fs-wedges">${p.wedges.length}/6</span><span class="fs-score">${p.score.toLocaleString()}</span></li>`).join("")}</ol>` : ""}
  </div>`;
}

function renderScores() {
  const rows = (state.scores || []).slice()
    .sort((a, b) => b.wedges.length - a.wedges.length || b.score - a.score)
    .map((p, i) => `<div class="score-row${state.turnPlayerId === p.id && state.status === "playing" ? " current" : ""}" data-key="s-${esc(p.id)}" data-score-host><span class="score-rank">${i + 1}</span><div class="score-wedge-circle">${wedgeCircleHTML(p.wedges || [])}</div><div class="score-row-player"><strong>${esc(p.name)}</strong><span class="score-row-wedges">${p.wedges.length} of 6 wedges</span></div><span class="score-row-points" data-score="${p.score}" data-live></span></div>`).join("");
  flip($("hostScores"), () => patch($("hostScores"), rows || `<div class="standings-empty" data-key="none">No players yet.</div>`));
}

/* ------------------------------------------------------------------ *
 * Player
 * ------------------------------------------------------------------ */
function renderPlayer() {
  const mine = me();
  $("joinPanel").hidden = !!mine;
  if (!mine) { $("playerGame").hidden = true; return; }
  $("playerGame").hidden = false;
  const isSwitch = state.round === "Switchagories";
  const playing = state.status === "playing";

  const showTimer = playing && state.stage === "answering";
  patch($("playerRound"), `<div class="hud-row"><div class="hud-me" data-score-host><span class="player-wedge-circle">${wedgeCircleHTML(mine.wedges || [])}</span><div><div class="hud-name">${esc(mine.name)}</div><div class="hud-score"><span data-score="${mine.score}" data-live></span> pts</div></div></div><div class="hud-round"><div class="hud-round-name">${esc(roundName())}</div>${questionProgress() ? `<div class="hud-round-sub">${esc(questionProgress())}</div>` : ""}</div></div>${showTimer ? timerBarHTML() : ""}`);
  $("playerAnswers").className = "answers";

  const status = (msg, kind = "") => setPlayerStatus(msg, kind);

  if (state.status === "finished") {
    patch($("playerQuestion"), winnerCard(false));
    patch($("playerAnswers"), "");
    status(state.winnerId === myPlayerId ? "Great game!" : "Thanks for playing.", "ok");
    return;
  }

  if (state.status === "lobby") {
    patch($("playerQuestion"), `<div class="waiting-card" data-key="lobby-wait"><div class="waiting-pulse">${wedgeCircleHTML([])}</div><div class="waiting-title">You're in, ${esc(mine.name)}</div><div class="waiting-sub">Watch the TV — the game starts soon.</div><div class="waiting-players">${state.players.map(p => `<span class="${p.id === myPlayerId ? "me" : ""}" data-key="wp-${esc(p.id)}">${esc(p.name)}</span>`).join("")}</div></div>`);
    patch($("playerAnswers"), "");
    status("");
    return;
  }

  if (state.stage === "round-intro") {
    const finalInfo = state.round === "Final Round" && state.finalCategoryName ? categoryInfo(state.finalCategoryName) : null;
    patch($("playerQuestion"), stageCard("round", state.round || "Round", finalInfo ? finalInfo.name : "", finalInfo?.color, `${state.round}-${state.finalCategoryIndex ?? ""}`));
    patch($("playerAnswers"), "");
    status(state.paused ? "Game paused." : "Waiting for the host to begin.");
    return;
  }

  if (state.stage === "last-category" && state.finalQuestionPicker) {
    const picker = state.finalQuestionPicker;
    const myTurn = picker.playerId === myPlayerId;
    const pickerName = state.players.find(p => p.id === picker.playerId)?.name || "The last-place player";
    patch($("playerQuestion"), `<div class="pick-prompt${myTurn ? " my-pick" : ""}" data-key="pl-last-${myTurn}"><div class="question">${myTurn ? "Choose the category for the final question" : `${esc(pickerName)} is choosing the final category`}</div></div>`);
    $("playerAnswers").className = "answers category-grid";
    patch($("playerAnswers"), categoryChoicesHTML(picker.choices || [], { buttons: true, attr: "data-last-category", disabled: !myTurn || state.paused }));
    document.querySelectorAll("[data-last-category]").forEach(btn => btn.onclick = () => {
      btn.classList.add("chosen");
      vibrate(25);
      socket.emit("player:last-category", { category: btn.dataset.lastCategory }, result => {
        if (!result.ok) status(result.error, "error");
      });
    });
    status(state.paused ? "Game paused." : myTurn ? "Your pick — tap a category." : "Waiting for the category pick.", myTurn ? "turn" : "");
    return;
  }

  if (isSwitch && !state.question) {
    const myTurn = state.turnPlayerId === myPlayerId;
    const canChoose = myTurn && !state.paused;
    const choices = state.switchagoriesCategoryChoices || [];
    patch($("playerQuestion"), `<div class="pick-prompt${myTurn ? " my-pick" : ""}" data-key="pl-sw-${myTurn}-${esc(state.turnPlayerId)}"><div class="question">${myTurn ? "Choose a category for your question" : `${esc(state.turnPlayerName || "Another player")} is choosing a category`}</div></div>`);
    $("playerAnswers").className = "answers category-grid";
    patch($("playerAnswers"), categoryChoicesHTML(choices, { buttons: true, attr: "data-switch-category", disabled: !canChoose }));
    document.querySelectorAll("[data-switch-category]").forEach(btn => btn.onclick = () => {
      btn.classList.add("chosen");
      vibrate(25);
      socket.emit("player:switch-category", { category: btn.dataset.switchCategory }, result => {
        if (!result.ok) status(result.error, "error");
      });
    });
    status(state.paused ? "Game paused — waiting for the host to resume." : (myTurn ? "Your pick — tap a category." : `Waiting for ${state.turnPlayerName}.`), myTurn ? "turn" : "");
    return;
  }

  if (!state.question) {
    patch($("playerQuestion"), `<div class="waiting-card compact" data-key="between"><div class="waiting-title">${esc(state.notice || "Get ready")}</div><div class="waiting-sub">Eyes on the TV.</div></div>`);
    patch($("playerAnswers"), "");
    status("");
    return;
  }

  const info = categoryInfo(state.question.category);
  const qid = state.question.id;
  if (state.stage === "category-preview") {
    patch($("playerQuestion"), stageCard("category", info.name, "", info.color, `cat-${qid}`));
    patch($("playerAnswers"), "");
    status("");
    return;
  }
  if (state.stage === "question-preview") {
    patch($("playerQuestion"), `<div class="question-block preview" data-key="q-${esc(qid)}" style="--category-color:${esc(colorValue(info.color))}">${categoryBanner(info)}<div class="question">${esc(state.question.question)}</div></div>`);
    patch($("playerAnswers"), "");
    status("Answers unlock when the timer starts.");
    return;
  }

  const closeCallReveal = state.round === "Close Call" && state.revealed && Array.isArray(state.answer) ? closeCallOrderHTML() : "";
  patch($("playerQuestion"), `<div class="question-block" data-key="q-${esc(qid)}" style="--category-color:${esc(colorValue(info.color))}">${categoryBanner(info)}<div class="question">${esc(state.question.question)}</div></div>${closeCallReveal}`);
  if (!stageQuestionVisible()) {
    patch($("playerAnswers"), "");
    status("Answers unlock when the timer starts.");
    return;
  }
  const isTurnBased = ["Grab Bag", "Close Call"].includes(state.round);
  const myTurn = !isTurnBased || state.turnPlayerId === myPlayerId;
  const finalEliminated = state.round === "Final Round" && (state.eliminatedPlayerIds || []).includes(myPlayerId);
  const mySelections = (state.answerSelections || []).filter(a => a.playerId === myPlayerId);
  const claimedBy = state.claimedAnswers || {};
  const oneAnswerOnly = ["Quickstarter", "Switchagories", "Final Round"].includes(state.round);
  const disabled = state.paused || !myTurn || state.revealed || finalEliminated || (oneAnswerOnly && mySelections.length > 0);
  const playerOptionClass = value => {
    const mineSel = mySelections.find(a => a.value === value);
    const claimed = Object.prototype.hasOwnProperty.call(claimedBy, value);
    if (state.round === "Grab Bag" && state.revealed) {
      return state.answer?.includes(value) ? "selected-correct" : (mineSel ? "selected-wrong" : "dim-wrong");
    }
    if (state.round === "Grab Bag" && mineSel) return mineSel.correct ? "selected-correct" : "selected-wrong";
    if (state.round === "Grab Bag" && claimed) return "claimed-gray";
    if (state.round === "Close Call" && mineSel) return state.revealed ? "close-call-picked" : "selected-gray";
    if (state.round === "Close Call" && claimed) return "claimed-gray";
    if (oneAnswerOnly) {
      if (!state.revealed) return mineSel ? "selected-gray mine" : "";
      if (value === state.answer) return `selected-correct${mineSel ? " mine" : ""}`;
      return mineSel ? "selected-wrong mine" : "dim-wrong";
    }
    return "";
  };
  $("playerAnswers").className = "answers" + (state.round === "Grab Bag" ? " grab-grid" : "") + (state.revealed ? " is-revealed" : "") + (disabled ? " is-locked" : "");
  patch($("playerAnswers"), state.question.options.map((x, i) => {
    // Only Grab Bag and Close Call lock choices across players.
    const locksChoices = state.round === "Grab Bag" || state.round === "Close Call";
    const claimedByOther = locksChoices && Object.prototype.hasOwnProperty.call(claimedBy, x) && claimedBy[x] !== myPlayerId;
    const claimedBySelf = locksChoices && Object.prototype.hasOwnProperty.call(claimedBy, x) && claimedBy[x] === myPlayerId;
    const optionDisabled = disabled || claimedByOther || (state.round === "Grab Bag" && claimedBySelf);
    return `<button class="answer ${playerOptionClass(x)}" data-key="pa-${esc(qid)}-${i}" style="--i:${i}" data-player-answer="${esc(x)}" ${optionDisabled ? "disabled" : ""}><span class="answer-key">${LETTERS[i] || ""}</span><span class="answer-text">${esc(x)}</span></button>`;
  }).join(""));

  if (finalEliminated) {
    status("You're out for this Final Round category. Watch for the next one.", "error");
    return;
  }

  document.querySelectorAll("[data-player-answer]").forEach(btn => btn.onclick = () => {
    document.querySelectorAll("[data-player-answer]").forEach(b => b.disabled = true);
    btn.classList.add("selected-gray", "mine", "just-picked");
    vibrate(20);
    socket.emit("player:answer", { value: btn.dataset.playerAnswer }, result => {
      if (!result.ok) {
        btn.classList.remove("selected-gray", "mine", "just-picked");
        render();
        return status(result.error, "error");
      }
      const msg = { correct:"Correct — locked in.", wrong:"Not on the list — you're out for this question.", top:"Top answer selected.", selected:"Answer locked in." };
      if (result.result === "correct") vibrate([20, 40, 20]);
      if (result.result === "wrong") vibrate(120);
      status(msg[result.result] || "Answer locked in.", result.result === "wrong" ? "error" : "ok");
    });
  });

  if (state.paused) status("Game paused — waiting for the host to resume.");
  else if (state.revealed) status(formatPlayerAnswer(state), "ok");
  else if (oneAnswerOnly) status(mySelections.length ? "Locked in — waiting for everyone else." : "Pick your answer.", mySelections.length ? "ok" : "turn");
  else status(isTurnBased ? (myTurn ? "Your turn — pick an answer." : `Waiting for ${state.turnPlayerName}.`) : "Pick your answer.", myTurn ? "turn" : "");
}

function setPlayerStatus(msg, kind = "") {
  const el = $("playerStatus");
  el.hidden = !msg;
  if (el.textContent !== msg) el.textContent = msg;
  el.className = `status${kind ? ` ${kind}` : ""}`;
}

function stageQuestionVisible() { return state.stage === "answering" || state.revealed; }

function formatAnswer(s) {
  if (!s.answer) return "";
  if (Array.isArray(s.answer)) {
    if (s.round === "Grab Bag") return `<span class="reveal-label">Correct options</span><span class="correct-options">${s.answer.map(esc).join(", ")}</span>`;
    return `<span class="reveal-label">Correct order</span><span>${s.answer.map(esc).join(" → ")}</span>`;
  }
  const fact = ["Quickstarter", "Switchagories"].includes(s.round) ? (s.question?.facts || "") : "";
  return `<span class="reveal-label">Answer</span><span class="reveal-answer">${esc(s.answer)}</span>${fact ? `<span class="reveal-fact">${esc(fact)}</span>` : ""}`;
}

function formatPlayerAnswer(s) {
  if (!s.answer) return "";
  if (Array.isArray(s.answer)) {
    if (s.round === "Grab Bag") return `Correct options: ${s.answer.join(", ")}`;
    return `Correct order: ${s.answer.join(" → ")}`;
  }
  const fact = ["Quickstarter", "Switchagories"].includes(s.round) ? (s.question?.facts || "") : "";
  return `Answer: ${s.answer}${fact ? ` — ${fact}` : ""}`;
}
