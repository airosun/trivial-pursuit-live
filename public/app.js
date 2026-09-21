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
  return state?.categories?.find(c => String(c.name).toLowerCase() === String(name || "").toLowerCase()) || { name, color: "#777" };
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
  if (!state?.timerEndsAt || state.revealed) return "";
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
    scores: (s.scores || []).map(p => ({ id:p.id, score:p.score, wedges:(p.wedges || []).length }))
  };
}

function updateVisualTransitions(prev, next) {
  if (!prev || !next) return;
  if (next.status === 'finished' && prev.status !== 'finished') {
    showTransition('GAME OVER', next.winnerName || 'Winner', 'The game is complete', 1800);
    playTone('win');
    return;
  }
  if (next.round !== prev.round && next.round) {
    showTransition('NEXT ROUND', next.round, 'Get ready!', 1200);
    playTone('transition');
    return;
  }
  if (next.round === 'Final Round' && next.finalCategoryName !== prev.finalCategoryName && next.finalCategoryName) {
    showTransition('FINAL ROUND', next.finalCategoryName, `Category ${(next.finalCategoryIndex ?? 0) + 1} of ${next.finalCategoryCount}`, 1200);
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
  const oldById = new Map((prev.scores || []).map(p => [p.id, p]));
  for (const p of next.scores || []) {
    const old = oldById.get(p.id);
    if (old && p.wedges > old.wedges) {
      highlightPlayer(p.id);
      playTone('wedge');
    }
  }
}

function showTransition(kicker, title, subtitle, ms=1200) {
  const overlay = $('transitionOverlay');
  if (!overlay) return;
  $('transitionKicker').textContent = kicker;
  $('transitionTitle').textContent = title;
  $('transitionSubtitle').textContent = subtitle;
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

function renderHost() {
  $("hostCode").textContent = state.code;
  $("hostControls").hidden = false;
  $("hostPlayers").innerHTML = state.players.length
    ? state.players.map(p => `<div class="tv-player ${state.turnPlayerId === p.id ? "current" : ""}" data-player-id="${esc(p.id)}"><div class="tv-player-name">${esc(p.name)} ${state.turnPlayerId === p.id ? "• TURN" : ""}</div><div class="tv-player-score">${p.score.toLocaleString()} <small>pts</small></div><div class="wedge-row">${wedgeHTML(p.wedges || [])}</div>${p.connected ? "" : '<div class="tv-player-offline">OFFLINE</div>'}</div>`).join("")
    : '<span class="muted">No players yet.</span>';
  $("tvRoundBadge").textContent = state.status === "finished" ? "GAME OVER" : (state.round || "LOBBY").toUpperCase();

  $("categoryEditor").innerHTML = state.categories.map(c =>
    `<div class="category" data-color="${esc(c.color)}"><div class="category-label"><span class="swatch" style="background:${esc(colorValue(c.color))}"></span>${esc(c.color)}</div><input value="${esc(c.name)}"></div>`).join("");

  $("startGame").disabled = state.status !== "lobby";
  $("reveal").disabled = state.status !== "playing" || state.revealed;
  $("next").disabled = state.status !== "playing" || !state.revealed;
  $("skipTurn").disabled = state.status !== "playing" || state.revealed || !["Grab Bag","Close Call","Switchagories"].includes(state.round);

  $("hostRound").innerHTML = `<div class="round-title">${headerText()} <span id="hostTimer" class="timer">${timerText()}</span></div>${roundMeta()}`;

  if (!state.question) {
    $("hostQuestion").innerHTML = state.status === "finished" ? winnerCard() : emptyGameCard();
    $("hostAnswers").innerHTML = "";
    $("hostReveal").textContent = state.notice || "Waiting for the host to start.";
    renderScores();
    return;
  }

  const info = categoryInfo(state.question.category);
  $("hostQuestion").innerHTML = `<div class="category-banner" style="--category-color:${esc(colorValue(info.color))}"><span>${esc(info.name)}</span><span>${esc(info.color)}</span></div><div class="question">${esc(state.question.question)}</div>`;
  $("hostAnswers").innerHTML = state.question.options.map((x,i) => `<div class="answer static-answer">${i+1}. ${esc(x)}</div>`).join("");
  $("hostReveal").textContent = state.revealed ? formatAnswer(state) : (state.notice || (state.turnPlayerName && ["Grab Bag","Close Call"].includes(state.round) ? `Waiting for ${state.turnPlayerName}.` : "Answers are being collected."));
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
  return `<div class="winner-card"><div class="winner-kicker">WINNER</div><div class="winner-name">${esc(state.winnerName || "Winner")}</div><div>${winner ? `${winner.wedges?.length || 0}/6 wedges • ${winner.score.toLocaleString()} points` : ""}</div></div>`;
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
    $("playerAnswers").innerHTML = state.categories.map(c => `<button class="answer category-choice" data-switch-category="${esc(c.name)}" ${!myTurn ? "disabled" : ""}><span class="swatch" style="background:${esc(colorValue(c.color))}"></span>${esc(c.name)}</button>`).join("");
    document.querySelectorAll("[data-switch-category]").forEach(btn => btn.onclick = () => socket.emit("player:switch-category", { category: btn.dataset.switchCategory }, result => {
      if (!result.ok) setStatus("playerStatus", result.error, true);
    }));
    setStatus("playerStatus", myTurn ? "It's your turn — choose a category." : `Waiting for ${state.turnPlayerName}.`, false);
    return;
  }

  const info = categoryInfo(state.question.category);
  $("playerQuestion").innerHTML = `<div class="category-banner" style="--category-color:${esc(colorValue(info.color))}"><span>${esc(info.name)}</span><span>${esc(info.color)}</span></div><div class="question">${esc(state.question.question)}</div>`;
  const isTurnBased = ["Grab Bag", "Close Call", "Switchagories"].includes(state.round);
  const myTurn = !isTurnBased || state.turnPlayerId === myPlayerId;
  const finalEliminated = state.round === "Final Round" && (state.eliminatedPlayerIds || []).includes(myPlayerId);
  const disabled = !myTurn || state.revealed || finalEliminated;
  $("playerAnswers").className = "answers " + (state.round === "Grab Bag" ? "grab-grid" : "");
  $("playerAnswers").innerHTML = state.question.options.map((x,i) => `<button class="answer" data-player-answer="${esc(x)}" ${disabled ? "disabled" : ""}>${i+1}. ${esc(x)}</button>`).join("");

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
  else setStatus("playerStatus", isTurnBased ? (myTurn ? "It's your turn." : `Waiting for ${state.turnPlayerName}.`) : "Choose your answer.", false);
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
