const socket = io();
let role = "host";
let state = null;
let timerInterval = null;
let myPlayerId = sessionStorage.getItem("tpPlayerId") || null;
let playerReconnectToken = sessionStorage.getItem("tpPlayerReconnectToken") || null;
let playerGameCode = sessionStorage.getItem("tpPlayerGameCode") || null;
let hostToken = sessionStorage.getItem("tpHostToken") || null;
let hostGameCode = sessionStorage.getItem("tpHostGameCode") || null;
let previousVisualState = null;
let transitionTimer = null;
let audioContext = null;

const $ = id => document.getElementById(id);
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;" }[c]));

if (playerGameCode) $("joinCode").value = playerGameCode;
if (sessionStorage.getItem("tpPlayerName")) $("playerName").value = sessionStorage.getItem("tpPlayerName");

function categoryInfo(name) {
  const key = String(name || "").toLowerCase();
  return state?.categories?.find(c => String(c.name).toLowerCase() === key || String(c.color).toLowerCase() === key) || { name, color: "#777" };
}

function colorValue(color) {
  const known = { pink:"#e85aa8", orange:"#f28c28", yellow:"#e7c83b", green:"#43a86b", blue:"#4d82d9", purple:"#8b5bc7" };
  return known[String(color || "").toLowerCase()] || color || "#777";
}

function wedgeHTML(wedges = []) {
  return wedges.map((w, i) => {
    const info = categoryInfo(w);
    return `<span class="wedge" title="${esc(info.name || w)}" style="--wedge-color:${esc(colorValue(info.color || w))}">${i + 1}</span>`;
  }).join("");
}

function me() {
  return state?.players?.find(p => p.id === myPlayerId) || null;
}

function switchRole(next) {
  role = next;
  $("hostScreen").hidden = role !== "host";
  $("playerScreen").hidden = role !== "player";
  $("hostTab").classList.toggle("active", role === "host");
  $("playerTab").classList.toggle("active", role === "player");
  render();
}

$("hostTab").onclick = () => switchRole("host");
$("playerTab").onclick = () => switchRole("player");
$("fullscreenHost").onclick = async () => { try { if (!document.fullscreenElement) await document.documentElement.requestFullscreen(); else await document.exitFullscreen(); } catch {} };

$("createGame").onclick = async () => {
  const response = await fetch("/api/games", { method:"POST", headers:{ "Content-Type":"application/json" }, body:"{}" });
  const data = await response.json();
  hostToken = data.hostToken;
  hostGameCode = data.code;
  sessionStorage.setItem("tpHostToken", hostToken);
  sessionStorage.setItem("tpHostGameCode", hostGameCode);
  $("hostCode").textContent = data.code;
  $("joinCode").value = data.code;
  $("hostControls").hidden = false;
  connectHost(data.code, data.hostToken);
};

$("uploadWorkbook").onclick = async () => {
  if (!state) return setStatus("uploadStatus", "Create a game first.", true);
  const file = $("workbook").files[0];
  if (!file) return setStatus("uploadStatus", "Choose your Excel workbook first.", true);
  const form = new FormData();
  form.append("workbook", file);
  const response = await fetch(`/api/games/${state.code}/questions`, { method:"POST", body:form });
  const data = await response.json();
  if (!response.ok) return setStatus("uploadStatus", [data.error, ...(data.details || [])].join("\n"), true);
  setStatus("uploadStatus", `Validated ${data.questionCount} questions and ${data.finalGroups} final-round groups.`, false);
};

$("saveCategories").onclick = () => {
  const categories = [...document.querySelectorAll(".category")].map(row => ({
    color: row.dataset.color, name: row.querySelector("input").value.trim()
  }));
  socket.emit("host:categories", { categories }, result => {
    if (!result.ok) setStatus("hostStatus", result.error, true);
  });
};

$("startGame").onclick = () => socket.emit("host:start", {}, result => {
  if (!result.ok) setStatus("hostReveal", result.error, true);
});
$("reveal").onclick = () => socket.emit("host:reveal", {}, result => {
  if (!result.ok) setStatus("hostReveal", result.error, true);
});
$("next").onclick = () => socket.emit("host:next", {}, result => {
  if (!result.ok) setStatus("hostReveal", result.error, true);
});
$("skipTurn").onclick = () => socket.emit("host:skip-turn", {}, result => {
  if (!result.ok) setStatus("hostReveal", result.error, true);
});

$("joinGame").onclick = () => {
  const code = $("joinCode").value.trim().toUpperCase();
  const name = $("playerName").value.trim();
  playerGameCode = code;
  sessionStorage.setItem("tpPlayerGameCode", code);
  sessionStorage.setItem("tpPlayerName", name);
  connectPlayer(code, name, null);
};

function connectHost(code, token) {
  socket.emit("host:create", { code, hostToken: token }, result => {
    if (!result.ok) return setStatus("hostStatus", result.error, true);
    state = result.state;
    $("hostCode").textContent = code;
    $("hostControls").hidden = false;
    render();
  });
}

function connectPlayer(code, name, reconnectToken) {
  socket.emit("player:join", { code, name, reconnectToken }, result => {
    if (!result.ok) return setStatus("joinStatus", result.error, true);
    myPlayerId = result.playerId;
    playerReconnectToken = result.reconnectToken;
    playerGameCode = code;
    sessionStorage.setItem("tpPlayerId", myPlayerId);
    sessionStorage.setItem("tpPlayerReconnectToken", playerReconnectToken);
    sessionStorage.setItem("tpPlayerGameCode", code);
    if (name) sessionStorage.setItem("tpPlayerName", name);
    state = result.state;
    setStatus("joinStatus", result.reconnected ? "Reconnected to the game." : "Joined game.", false);
    render();
  });
}

socket.on("connect", () => {
  setConnectionBadge(true);
  if (hostToken && hostGameCode) connectHost(hostGameCode, hostToken);
  else if (playerReconnectToken && playerGameCode) connectPlayer(playerGameCode, sessionStorage.getItem("tpPlayerName") || "", playerReconnectToken);
});

socket.on("disconnect", () => {
  setConnectionBadge(false);
  if (role === "host") setStatus("hostStatus", "Connection lost — reconnecting…", true);
  else setStatus("joinStatus", "Connection lost — reconnecting…", true);
});
socket.on("player:removed", info => {
  sessionStorage.removeItem("tpPlayerId");
  sessionStorage.removeItem("tpPlayerReconnectToken");
  sessionStorage.removeItem("tpPlayerGameCode");
  myPlayerId = null;
  playerReconnectToken = null;
  playerGameCode = null;
  state = null;
  setStatus("joinStatus", info?.message || "You were removed from the lobby.", true);
  render();
});

socket.on("state", next => { state = next; render(); });
socket.on("answerCount", info => {
  if (role === "host") setStatus("hostReveal", `${info.answered} of ${info.total} players have answered.`);
});

function setConnectionBadge(connected) {
  for (const id of ["connectionBadge", "playerConnectionBadge"]) { const el=$(id); if (!el) continue; el.textContent=connected ? "Connected" : "Reconnecting…"; el.classList.toggle("offline", !connected); }
}

function setStatus(id, message, error=false) {
  const el = $(id);
  if (!el) return;
  el.textContent = message;
  el.classList.toggle("error", error);
  el.classList.toggle("ok", !error);
}

function timerText() {
  if (!state?.timerEndsAt || state.revealed || state.stage !== "answering") return "";
  return `${Math.max(0, Math.ceil((state.timerEndsAt - Date.now()) / 1000))}s`;
}

function render() {
  if (!state) return;
  const previous = previousVisualState;
  renderHost();
  renderPlayer();
  updateVisualTransitions(previous, state);
  previousVisualState = snapshotVisualState(state);
  clearInterval(timerInterval);
  timerInterval = setInterval(() => {
    const t = timerText();
    if ($('hostTimer')) $('hostTimer').textContent = t;
    if ($('playerTimer')) $('playerTimer').textContent = t;
    const seconds = state?.timerEndsAt ? Math.max(0, Math.ceil((state.timerEndsAt - Date.now()) / 1000)) : 0;
    document.body.classList.toggle('timer-critical', seconds > 0 && seconds <= 5 && !state?.revealed);
  }, 200);
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
    scores: (s.scores || []).map(p => ({ id:p.id, score:p.score, wedges:(p.wedges || []).length, wedgesList:(p.wedges || []) }))
  };
}

function updateVisualTransitions(prev, next) {
  if (!prev || !next) return;
  if (next.status === 'finished' && prev.status !== 'finished') {
    showTransition('GAME OVER', next.winnerName || 'Winner', 'The game is complete', 1800);
    celebrateWinner();
    return;
  }
  if (next.round !== prev.round && next.round) {
    showTransition('NEXT ROUND', next.round, 'Get ready!', 1200);
    playTone('transition');
    return;
  }
  if (next.round === 'Final Round' && next.finalCategoryName !== prev.finalCategoryName && next.finalCategoryName) {
    showTransition('FINAL ROUND', next.finalCategoryName, `Category ${(next.finalCategoryIndex ?? 0) + 1} of ${next.finalCategoryCount}`, 1200, categoryInfo(next.finalCategoryName).color);
    playTone('transition');
    return;
  }
  if (next.question && next.question.id !== prev.question) {
    document.body.classList.remove('question-enter');
    requestAnimationFrame(() => document.body.classList.add('question-enter'));
    setTimeout(() => document.body.classList.remove('question-enter'), 450);
    playTone('question');
  }
  if (next.revealed && !prev.revealed) {
    document.body.classList.add('answer-reveal');
    setTimeout(() => document.body.classList.remove('answer-reveal'), 600);
    playTone('reveal');
  }
  const oldAwardIds = new Set((prev.wedgeAwards || []).map(a => a.id));
  for (const award of next.wedgeAwards || []) {
    if (!oldAwardIds.has(award.id)) {
      if (role === 'host') showWedgeAward(award.playerName, award.color);
      highlightPlayer(award.playerId);
    }
  }
  // Fallback for older state snapshots that do not contain wedge award events.
  const oldById = new Map((prev.scores || []).map(p => [p.id, p]));
  for (const p of next.scores || []) {
    const old = oldById.get(p.id);
    if (!next.wedgeAwards?.length && old && p.wedges.length > old.wedges) {
      const newWedge = (p.wedgesList || p.wedges || [])[p.wedges.length - 1];
      if (role === 'host') showWedgeAward(p.name, newWedge);
      highlightPlayer(p.id);
    }
  }
  if (next.selectionNotice && next.selectionNotice !== prev.selectionNotice) showSelectionDialog(next.selectionNotice);
}

function showTransition(kicker, title, subtitle, ms=1200, accentColor=null) {
  const overlay = $('transitionOverlay');
  if (!overlay) return;
  $('transitionKicker').textContent = kicker;
  $('transitionTitle').textContent = title;
  $('transitionSubtitle').textContent = subtitle;
  overlay.style.setProperty('--transition-accent', colorValue(accentColor || '#9da5b8'));
  overlay.hidden = false;
  overlay.classList.remove('show');
  requestAnimationFrame(() => overlay.classList.add('show'));
  clearTimeout(transitionTimer);
  transitionTimer = setTimeout(() => {
    overlay.classList.remove('show');
    setTimeout(() => { overlay.hidden = true; }, 300);
  }, ms);
}

function highlightPlayer(playerId) {
  document.querySelectorAll('.tv-player').forEach(el => {
    if (el.dataset.playerId === playerId) {
      el.classList.remove('wedge-award');
      requestAnimationFrame(() => el.classList.add('wedge-award'));
      setTimeout(() => el.classList.remove('wedge-award'), 1000);
    }
  });
}

function showWedgeAward(name, wedge) {
  const overlay = $('wedgeAwardOverlay');
  if (!overlay) return;
  const color = colorValue(categoryInfo(wedge).color || wedge);
  $('wedgeAwardName').textContent = `${name} gained a wedge!`;
  $('wedgeAwardVisual').style.background = color;
  overlay.style.setProperty('--award-color', color);
  overlay.hidden = false;
  overlay.classList.remove('show');
  requestAnimationFrame(() => overlay.classList.add('show'));
  clearTimeout(window.__wedgeAwardTimer);
  playWedgeFanfare();
  window.__wedgeAwardTimer = setTimeout(() => {
    overlay.classList.remove('show');
    setTimeout(() => { overlay.hidden = true; }, 220);
  }, 2600);
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
      osc.type = i === notes.length - 1 ? 'triangle' : 'sine';
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
  const dialog = $('selectionDialog');
  if (!dialog) return;
  $('selectionDialogText').textContent = message;
  dialog.hidden = false;
  dialog.classList.remove('show');
  requestAnimationFrame(() => dialog.classList.add('show'));
  clearTimeout(window.__selectionDialogTimer);
  window.__selectionDialogTimer = setTimeout(() => {
    dialog.classList.remove('show');
    setTimeout(() => { dialog.hidden = true; }, 220);
  }, 1500);
}

function celebrateWinner() {
  for (let i = 0; i < 90; i++) {
    const el = document.createElement('div');
    el.className = 'confetti-piece';
    el.style.setProperty('--left', `${Math.random()*100}vw`);
    el.style.setProperty('--fall', `${2.2 + Math.random()*2.2}s`);
    el.style.setProperty('--rot', `${Math.random()*360}deg`);
    el.style.setProperty('--confetti-color', ['#e85aa8','#f28c28','#e7c83b','#43a86b','#4d82d9','#8b5bc7'][i%6]);
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 5000);
  }
  playTone('win');
}

function playTone(kind) {
  try {
    audioContext ||= new (window.AudioContext || window.webkitAudioContext)();
    const ctx = audioContext;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    const tones = { question:[520,.07], reveal:[700,.10], transition:[420,.14], wedge:[880,.16], win:[660,.22] };
    const [freq,duration] = tones[kind] || tones.question;
    osc.frequency.value = freq;
    osc.type = 'sine';
    gain.gain.setValueAtTime(0.0001, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.045, ctx.currentTime + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + duration);
    osc.connect(gain).connect(ctx.destination);
    osc.start(); osc.stop(ctx.currentTime + duration + 0.02);
  } catch {}
}

function roundTitle() {
  if (state.status === "finished") return "Game finished";
  if (state.round === "Final Round" && state.finalCategoryName) return `Final Round • ${esc(categoryInfo(state.finalCategoryName).name)}`;
  return esc(state.round || "Lobby");
}

function headerText() {
  if (!state.question) return roundTitle();
  const turn = state.turnPlayerName ? ` • Turn: ${esc(state.turnPlayerName)}` : "";
  const questionNo = state.round === "Final Round" ? state.questionIndex + 1 : state.questionIndex + 1;
  return `${roundTitle()} • Question ${questionNo} of ${state.questionCount}${turn}`;
}

function stageCard(kind, title, subtitle="", color=null) {
  const cls = kind === "round" ? "stage-card round-stage" : kind === "category" ? "stage-card category-stage" : "stage-card question-stage";
  const style = color ? ` style="--category-color:${esc(colorValue(color))}"` : "";
  return `<div class="${cls}"${style}><div><div class="stage-kicker">${kind === "round" ? "NEXT ROUND" : kind === "category" ? "CATEGORY" : "QUESTION"}</div><div class="stage-title">${esc(title)}</div>${subtitle ? `<div class="stage-subtitle">${esc(subtitle)}</div>` : ""}</div></div>`;
}

function stageQuestionVisible() { return state.stage === "answering" || state.revealed; }

function renderHost() {
  $("hostCode").textContent = state.code;
  $("hostControls").hidden = false;
  $("hostPlayers").innerHTML = state.players.length
    ? state.players.map(p => `<div class="tv-player ${state.turnPlayerId === p.id ? "current" : ""}" data-player-id="${esc(p.id)}"><div class="tv-player-name">${esc(p.name)} ${state.turnPlayerId === p.id ? "• TURN" : ""}</div><div class="tv-player-score">${p.score.toLocaleString()} <small>pts</small></div><div class="wedge-row">${wedgeHTML(p.wedges || [])}</div>${p.connected ? "" : '<div class="tv-player-offline">OFFLINE</div>'}${state.status === "lobby" ? `<button class="remove-player-btn" data-remove-player="${esc(p.id)}">Remove</button>` : ""}</div>`).join("")
    : '<span class="muted">No players yet.</span>';
  document.querySelectorAll("[data-remove-player]").forEach(btn => btn.onclick = () => {
    if (!confirm("Remove this player from the lobby?")) return;
    socket.emit("host:remove-player", { playerId: btn.dataset.removePlayer }, result => {
      if (!result.ok) setStatus("hostStatus", result.error, true);
    });
  });
  $("tvRoundBadge").textContent = state.status === "finished" ? "GAME OVER" : (state.round || "LOBBY").toUpperCase();

  $("categoryEditor").innerHTML = state.categories.map(c =>
    `<div class="category" data-color="${esc(c.color)}"><div class="category-label"><span class="swatch" style="background:${esc(colorValue(c.color))}"></span>${esc(c.color)}</div><input value="${esc(c.name)}"></div>`).join("");

  $("startGame").disabled = state.status !== "lobby";
  $("reveal").disabled = state.status !== "playing" || state.revealed || state.stage !== "answering";
  $("next").disabled = state.status !== "playing" || state.stage === "switch-category" || state.stage === "category-preview" || (state.stage === "answering" && !state.revealed);
  $("skipTurn").disabled = state.status !== "playing" || state.revealed || !["Grab Bag","Close Call","Switchagories"].includes(state.round);

  $("hostRound").innerHTML = `<div class="round-title">${headerText()} <span id="hostTimer" class="timer">${timerText()}</span></div>${roundMeta()}`;

  if (state.status === "finished") {
    $("hostQuestion").innerHTML = winnerCard();
    $("hostAnswers").innerHTML = "";
    $("hostReveal").textContent = state.notice || "Game over.";
    renderScores();
    return;
  }

  if (state.stage === "round-intro") {
    const title = state.round === "Final Round" ? "FINAL ROUND" : (state.round || "ROUND").toUpperCase();
    const finalInfo = state.round === "Final Round" && state.finalCategoryName ? categoryInfo(state.finalCategoryName) : null;
    const finalSubtitle = finalInfo ? finalInfo.name : "Press Next when you're ready.";
    $("hostQuestion").innerHTML = stageCard("round", title, finalSubtitle, finalInfo?.color);
    $("hostAnswers").innerHTML = "";
    $("hostReveal").textContent = "Press Next to begin this round.";
    renderScores();
    return;
  }

  if (state.round === "Switchagories" && !state.question) {
    const choices = state.switchagoriesCategoryChoices || [];
    const turn = state.turnPlayerName ? `<div class="question">${esc(state.turnPlayerName)} is choosing between:</div>` : "";
    $("hostQuestion").innerHTML = `${turn}<div class="answers category-grid">${choices.map(c => `<div class="answer static-answer category-choice"><span class="swatch" style="background:${esc(colorValue(c.color))}"></span>${esc(c.name)}</div>`).join("")}</div>`;
    $("hostAnswers").innerHTML = "";
    $("hostReveal").textContent = "Waiting for the player to choose a category.";
    renderScores();
    return;
  }

  if (!state.question) {
    $("hostQuestion").innerHTML = emptyGameCard();
    $("hostAnswers").innerHTML = "";
    $("hostReveal").textContent = state.notice || "Waiting.";
    renderScores();
    return;
  }

  const info = categoryInfo(state.question.category);
  if (state.stage === "category-preview") {
    $("hostQuestion").innerHTML = stageCard("category", info.name, "", info.color);
    $("hostAnswers").innerHTML = "";
    $("hostReveal").textContent = "Category reveal — next comes the question.";
    renderScores();
    return;
  }
  if (state.stage === "question-preview") {
    $("hostQuestion").innerHTML = stageCard("question", state.question.question, `${info.name} • Press Next to start the timer.`);
    $("hostAnswers").innerHTML = "";
    $("hostReveal").textContent = "Press Next to begin answering.";
    renderScores();
    return;
  }
  $("hostQuestion").innerHTML = `<div class="category-banner" style="--category-color:${esc(colorValue(info.color))}"><span>${esc(info.name)}</span><span>${esc(info.color)}</span></div><div class="question">${esc(state.question.question)}</div>`;
  const selections = state.answerSelections || [];
  const selectionFor = value => selections.filter(a => a.value === value);
  const optionStateClass = value => {
    const picked = selectionFor(value);
    if (state.round === "Grab Bag") {
      if (state.revealed) return state.answer?.includes(value) ? "selected-correct" : "selected-wrong";
      if (!picked.length) return "";
      return picked[0].correct ? "selected-correct" : "selected-wrong";
    }
    if (state.round === "Close Call") {
      if (!picked.length) return "";
      return state.revealed ? "close-call-picked" : "selected-gray";
    }
    // Quickstarter, Switchagories, and Final Round reveal every option:
    // correct answers are green and incorrect answers are red. Before reveal
    // only the viewer's own selection is visible, so it appears gray.
    if (!state.revealed) return picked.length ? "selected-gray" : "";
    return value === state.answer ? "selected-correct" : "selected-wrong";
  };
  const optionPlayers = value => selectionFor(value).map(a => {
    let rankBadge = "";
    if (state.round === "Close Call" && state.revealed) {
      const rank = Array.isArray(state.answer) ? state.answer.indexOf(value) + 1 : 0;
      if (rank) rankBadge = `<span class="close-call-rank">Correct rank #${rank}</span>`;
    }
    return `<span class="answer-picker">${esc(a.playerName)}${rankBadge}</span>`;
  }).join("");
  $("hostAnswers").innerHTML = state.question.options.map((x,i) => {
    const picked = selectionFor(x);
    const val = state.round === "Close Call" && state.revealed ? (state.answerValues?.[i] ?? "") : "";
    return `<div class="answer static-answer ${optionStateClass(x)}">${i+1}. ${esc(x)}${val !== "" ? ` <strong class="close-call-value">(${esc(val)})</strong>` : ""}${picked.length ? `<div class="answer-pickers">${optionPlayers(x)}</div>` : ""}</div>`;
  }).join("");
  if (state.round === "Close Call" && state.revealed && Array.isArray(state.answer)) {
    const orderText = state.answer.map((a) => { const i = state.question.options.indexOf(a); const v = state.answerValues?.[i]; return `${esc(a)}${v !== undefined && v !== "" ? ` (${esc(v)})` : ""}`; }).join("  →  ");
    $("hostReveal").innerHTML = `<div class="close-call-reveal"><strong>CORRECT ORDER</strong><div>${orderText}</div></div>`;
  }
  if (!(state.round === "Close Call" && state.revealed && Array.isArray(state.answer))) {
    $("hostReveal").textContent = state.revealed ? formatAnswer(state) : (state.notice || (state.turnPlayerName && ["Grab Bag","Close Call"].includes(state.round) ? `Waiting for ${state.turnPlayerName}.` : "Answers are being collected."));
  }
  $("hostReveal").classList.toggle("ok", state.revealed);
  renderScores();
}

function roundMeta() {
  if (state.round === "Final Round") {
    const n = (state.finalCategoryIndex ?? 0) + 1;
    return `<div class="round-meta"><strong>Category ${n} of ${state.finalCategoryCount}</strong><span>${state.finalCategoryResolved ? "Category complete" : "Players still competing"}</span></div>`;
  }
  if (state.round === "Switchagories") {
    const turn = state.turnPlayerName ? `Current pick: ${esc(state.turnPlayerName)}` : "Choose a category";
    return `<div class="round-meta"><strong>Each player gets 2 category picks</strong><span>${turn}</span></div>`;
  }
  return `<div class="round-meta"><span>First four rounds: score thresholds award wedges</span><span>Wedges: 0–6</span></div>`;
}

function winnerCard() {
  const winner = state.players.find(p => p.id === state.winnerId);
  return `<div class="winner-card"><div class="winner-kicker">WINNER</div><div class="winner-name">${esc(state.winnerName || "Winner")}</div>${winner ? `<div class="winner-wedges">${wedgeHTML(winner.wedges || [])}</div><div>${winner.wedges?.length || 0}/6 wedges • ${winner.score.toLocaleString()} points</div>` : ""}</div>`;
}

function emptyGameCard() {
  return `<div class="empty-card"><strong>${esc(state.notice || "Waiting for the game to start")}</strong><span>Players can join with code <b>${esc(state.code)}</b>.</span></div>`;
}

function renderScores() {
  $("hostScores").innerHTML = (state.scores || []).slice()
    .sort((a,b) => b.wedges.length - a.wedges.length || b.score - a.score)
    .map(p => `<div class="score-row"><div><strong>${esc(p.name)}</strong><div class="wedge-row">${wedgeHTML(p.wedges || [])}</div></div><span>${p.wedges.length}/6</span><span>${p.score.toLocaleString()}</span></div>`).join("");
}

function renderPlayer() {
  const isSwitch = state.round === "Switchagories";
  if (!state.question && !isSwitch && state.status !== "finished") { $("playerGame").hidden = true; return; }
  $("playerGame").hidden = false;
  const mine = me();
  $("playerRound").innerHTML = `<div class="round-title">${headerText()} <span id="playerTimer" class="timer">${timerText()}</span></div>${playerMeta(mine)}`;

  if (state.status === "finished") {
    $("playerQuestion").innerHTML = winnerCard();
    $("playerAnswers").innerHTML = "";
    setStatus("playerStatus", state.winnerId === myPlayerId ? "You won the game!" : `${esc(state.winnerName || "Another player")} won the game.`, false);
    return;
  }

  if (isSwitch && !state.question) {
    const myTurn = state.turnPlayerId === myPlayerId;
    $("playerQuestion").innerHTML = `<div class="question">Choose a category for your question.</div>`;
    $("playerAnswers").className = "answers category-grid";
    const choices = state.switchagoriesCategoryChoices || [];
    $("playerAnswers").innerHTML = choices.map(c => `<button class="answer category-choice" data-switch-category="${esc(c.name)}" ${!myTurn ? "disabled" : ""}><span class="swatch" style="background:${esc(colorValue(c.color))}"></span>${esc(c.name)}</button>`).join("");
    document.querySelectorAll("[data-switch-category]").forEach(btn => btn.onclick = () => socket.emit("player:switch-category", { category: btn.dataset.switchCategory }, result => {
      if (!result.ok) setStatus("playerStatus", result.error, true);
    }));
    setStatus("playerStatus", myTurn ? "It's your turn — choose a category." : `Waiting for ${state.turnPlayerName}.`, false);
    return;
  }

  if (state.stage === "round-intro") {
    const title = state.round === "Final Round" ? "FINAL ROUND" : (state.round || "ROUND").toUpperCase();
    const finalInfo = state.round === "Final Round" && state.finalCategoryName ? categoryInfo(state.finalCategoryName) : null;
    const finalSubtitle = finalInfo ? finalInfo.name : "";
    $("playerQuestion").innerHTML = stageCard("round", title, finalSubtitle, finalInfo?.color);
    $("playerAnswers").innerHTML = "";
    setStatus("playerStatus", "Waiting for the host to begin.", false);
    return;
  }

  const info = categoryInfo(state.question.category);
  if (state.stage === "category-preview") {
    $("playerQuestion").innerHTML = stageCard("category", info.name, "", info.color);
    $("playerAnswers").innerHTML = "";
    setStatus("playerStatus", "Category reveal.", false);
    return;
  }
  if (state.stage === "question-preview") {
    $("playerQuestion").innerHTML = stageCard("question", state.question.question, `${info.name} • Waiting for the host.`);
    $("playerAnswers").innerHTML = "";
    setStatus("playerStatus", "Waiting for the host to start the timer.", false);
    return;
  }

  const closeCallReveal = state.round === "Close Call" && state.revealed && Array.isArray(state.answer)
    ? `<div class="close-call-reveal"><strong>CORRECT ORDER</strong><div>${state.answer.map((a, i) => { const oi=state.question.options.indexOf(a); const v=state.answerValues?.[oi]; return `${i+1}. ${esc(a)}${v !== undefined && v !== "" ? ` (${esc(v)})` : ""}`; }).join("  →  ")}</div></div>`
    : "";
  $("playerQuestion").innerHTML = `<div class="category-banner" style="--category-color:${esc(colorValue(info.color))}"><span>${esc(info.name)}</span><span>${esc(info.color)}</span></div><div class="question">${esc(state.question.question)}</div>${closeCallReveal}`;
  if (!stageQuestionVisible()) {
    $("playerAnswers").innerHTML = "";
    setStatus("playerStatus", "Waiting for the host to start the timer.", false);
    return;
  }
  const isTurnBased = ["Grab Bag", "Close Call"].includes(state.round);
  const myTurn = !isTurnBased || state.turnPlayerId === myPlayerId;
  const finalEliminated = state.round === "Final Round" && (state.eliminatedPlayerIds || []).includes(myPlayerId);
  const mySelections = (state.answerSelections || []).filter(a => a.playerId === myPlayerId);
  const claimedBy = state.claimedAnswers || {};
  const oneAnswerOnly = ["Quickstarter", "Switchagories", "Final Round"].includes(state.round);
  const disabled = !myTurn || state.revealed || finalEliminated || (oneAnswerOnly && mySelections.length > 0);
  const playerOptionClass = value => {
    const mine = mySelections.find(a => a.value === value);
    const claimed = Object.prototype.hasOwnProperty.call(claimedBy, value);
    if (state.round === "Grab Bag" && state.revealed) {
      return state.answer?.includes(value) ? "selected-correct" : "selected-wrong";
    }
    if (state.round === "Grab Bag" && mine) return mine.correct ? "selected-correct" : "selected-wrong";
    if (state.round === "Close Call" && mine) return state.revealed ? "close-call-picked" : "selected-gray";
    if (state.round === "Close Call" && claimed) return "claimed-gray";
    // Simultaneous rounds: gray while waiting; after reveal every option is
    // colored by whether it is the correct answer.
    if (["Quickstarter", "Switchagories", "Final Round"].includes(state.round)) {
      if (!state.revealed) return mine ? "selected-gray" : "";
      return value === state.answer ? "selected-correct" : "selected-wrong";
    }
    return "";
  };
  $("playerAnswers").className = "answers " + (state.round === "Grab Bag" ? "grab-grid" : "");
  $("playerAnswers").innerHTML = state.question.options.map((x,i) => {
    // Only Grab Bag and Close Call lock choices across players.
    // Quickstarter, Switchagories, and Final Round allow every player to
    // choose the same answer independently.
    const locksChoices = state.round === "Grab Bag" || state.round === "Close Call";
    const claimedByOther = locksChoices && Object.prototype.hasOwnProperty.call(claimedBy, x) && claimedBy[x] !== myPlayerId;
    const claimedBySelf = locksChoices && Object.prototype.hasOwnProperty.call(claimedBy, x) && claimedBy[x] === myPlayerId;
    const optionDisabled = disabled || claimedByOther || (state.round === "Grab Bag" && claimedBySelf);
    return `<button class="answer ${playerOptionClass(x)}" data-player-answer="${esc(x)}" ${optionDisabled ? "disabled" : ""}>${i+1}. ${esc(x)}</button>`;
  }).join("");

  if (finalEliminated) {
    setStatus("playerStatus", "You are eliminated from this Final Round category. Watch for the next category.", true);
    return;
  }

  document.querySelectorAll("[data-player-answer]").forEach(btn => btn.onclick = () => {
    document.querySelectorAll("[data-player-answer]").forEach(b => b.disabled = true);
    socket.emit("player:answer", { value:btn.dataset.playerAnswer }, result => {
      if (!result.ok) return setStatus("playerStatus", result.error, true);
      const msg = {correct:"Correct — your answer is locked in.",wrong:"Incorrect — you are out for this Grab Bag question.",top:"Top answer selected.",selected:"Answer selected."};
      setStatus("playerStatus", msg[result.result] || "Answer locked in.", false);
    });
  });

  if (state.revealed) setStatus("playerStatus", formatAnswer(state), false);
  else if (state.round === "Switchagories") {
    setStatus("playerStatus", mySelections.length ? "Answer selected — waiting for the other players." : "Choose your answer.", false);
  } else setStatus("playerStatus", isTurnBased ? (myTurn ? "It's your turn." : `Waiting for ${state.turnPlayerName}.`) : "Choose your answer.", false);
}

function playerMeta(mine) {
  if (!mine) return "";
  const wedgeText = `${mine.wedges?.length || 0}/6 wedges`;
  return `<div class="player-meta"><span>${esc(mine.name)}</span><span>${mine.score.toLocaleString()} pts</span><span class="wedge-row">${wedgeHTML(mine.wedges || [])}</span></div>`;
}

function formatAnswer(s) {
  if (!s.answer) return "";
  if (Array.isArray(s.answer)) return `Correct order: ${s.answer.join(" → ")}`;
  return `Correct answer: ${s.answer}`;
}
