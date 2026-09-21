import express from "express";
import http from "http";
import crypto from "crypto";
import multer from "multer";
import XLSX from "xlsx";
import { Server } from "socket.io";

const app = express();
const server = http.createServer(app);
const io = new Server(server);
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

app.use(express.static("public"));

const PORT = process.env.PORT || 3000;
const games = new Map();
const RECONNECT_GRACE_MS = 10000;

const DEFAULT_CATEGORIES = [
  { color: "Pink", name: "Entertainment" },
  { color: "Orange", name: "Sports" },
  { color: "Yellow", name: "History" },
  { color: "Green", name: "Science" },
  { color: "Blue", name: "Geography" },
  { color: "Purple", name: "Arts" }
];

function makeToken() {
  return crypto.randomBytes(24).toString("hex");
}

function makeCode() {
  let code;
  do {
    code = crypto.randomBytes(3).toString("hex").toUpperCase().slice(0, 6);
  } while (games.has(code));
  return code;
}

function clean(value) {
  return value == null ? "" : String(value).trim();
}

function normalizeCategory(value) {
  return clean(value).toLowerCase();
}

const WEDGE_THRESHOLDS = [2000, 6000, 12000, 20000, 30000, 42000];

function categoryColor(game, category) {
  const key = normalizeCategory(category);
  return game.categories.find(c => normalizeCategory(c.name) === key)?.color || category;
}

function checkScoreWedges(game, playerId, category) {
  const p = game.players.get(playerId);
  if (!p) return;
  p.wedges ||= [];
  p.scoreWedgesAwarded ||= 0;
  const color = categoryColor(game, category);

  while (p.scoreWedgesAwarded < WEDGE_THRESHOLDS.length && p.score >= WEDGE_THRESHOLDS[p.scoreWedgesAwarded]) {
    // The question's category/color determines the wedge earned when the threshold is crossed.
    p.wedges.push(color);
    p.scoreWedgesAwarded += 1;
  }
}

function parsePipe(value) {
  return clean(value).split("|").map(x => x.trim()).filter(Boolean);
}

function shuffle(items) {
  const a = [...items];
  for (let i = a.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function parseWorkbook(buffer) {
  const workbook = XLSX.read(buffer, { type: "buffer" });
  if (!workbook.SheetNames.length) throw new Error("Workbook has no sheets.");

  const categorySheet = workbook.Sheets[workbook.SheetNames[0]];
  const categoryRows = XLSX.utils.sheet_to_json(categorySheet, { header: 1, defval: "" });
  const categories = [];

  for (const row of categoryRows) {
    const color = clean(row[0]);
    const name = clean(row[1]);
    if (!color || color.toLowerCase() === "default") continue;
    categories.push({ color, name });
  }

  const questionSheetName = workbook.SheetNames[1];
  if (!questionSheetName) throw new Error("Workbook needs a second sheet containing questions.");

  const questionSheet = workbook.Sheets[questionSheetName];
  const rows = XLSX.utils.sheet_to_json(questionSheet, { defval: "" });
  const questions = rows.map((row, index) => {
    const type = clean(row.type).toLowerCase();
    const options = [];
    for (let i = 1; i <= 16; i++) {
      const value = clean(row[`op${i}`]);
      if (value) options.push(value);
    }
    return {
      row: index + 2,
      id: clean(row.id),
      category: normalizeCategory(row.category),
      type,
      question: clean(row.question),
      options,
      answer: clean(row.answer)
    };
  });

  validateQuestionSet(categories, questions);
  return { categories, questions };
}

function validateQuestionSet(categories, questions) {
  const errors = [];
  if (categories.length !== 6) {
    errors.push(`Categories sheet must contain exactly 6 colored categories; found ${categories.length}.`);
  }

  const seen = new Map();
  for (const q of questions) {
    if (!q.id) errors.push(`Row ${q.row}: missing id.`);
    if (!q.category) errors.push(`Row ${q.row}: missing category.`);
    if (!q.type) errors.push(`Row ${q.row}: missing type.`);
    if (!q.question) errors.push(`Row ${q.row}: missing question.`);
    seen.set(q.id, (seen.get(q.id) || 0) + 1);

    if (q.type === "multi-choice") {
      if (q.options.length !== 4) errors.push(`Row ${q.row}: multi-choice needs exactly 4 options.`);
      if (!q.options.includes(q.answer)) errors.push(`Row ${q.row}: answer must match one of op1-op4.`);
    } else if (q.type === "close-call") {
      const order = parsePipe(q.answer);
      if (q.options.length !== 5) errors.push(`Row ${q.row}: close-call needs exactly 5 options.`);
      if (order.length !== 5 || new Set(order).size !== 5 || order.some(x => !q.options.includes(x))) {
        errors.push(`Row ${q.row}: close-call answer must list all 5 options once using |.`);
      }
    } else if (q.type === "grab-bag") {
      const correct = parsePipe(q.answer);
      if (q.options.length !== 16) errors.push(`Row ${q.row}: grab-bag needs exactly 16 options.`);
      if (!correct.length || correct.some(x => !q.options.includes(x)) || new Set(correct).size !== correct.length) {
        errors.push(`Row ${q.row}: grab-bag answer must list valid correct options using |.`);
      }
    } else if (q.type === "final-round") {
      if (q.options.length !== 2) errors.push(`Row ${q.row}: final-round needs exactly 2 options.`);
      if (!q.options.includes(q.answer)) errors.push(`Row ${q.row}: final-round answer must be op1 or op2.`);
    } else {
      errors.push(`Row ${q.row}: unsupported type "${q.type}".`);
    }
  }

  for (const [id, count] of seen) {
    const q = questions.find(x => x.id === id);
    if (q?.type === "final-round") {
      if (count !== 5) errors.push(`Final-round id ${id} must occur exactly 5 times; found ${count}.`);
    } else if (count !== 1) {
      errors.push(`Question id ${id} must be unique; found ${count}.`);
    }
  }

  const finalGroups = groupFinalQuestions(questions);
  const finalCategories = new Set(finalGroups.map(g => g.category));
  if (finalGroups.length < 6 || finalCategories.size < 6) {
    errors.push(`Final round needs at least one 5-question set for each of the 6 categories; found ${finalCategories.size} categories.`);
  }

  for (const category of finalCategories) {
    const groupsForCategory = finalGroups.filter(g => g.category === category);
    for (const group of groupsForCategory) {
      const first = group.questions[0];
      if (!group.questions.every(q => q.options[0] === first.options[0] && q.options[1] === first.options[1])) {
        errors.push(`Final-round id ${group.id}: all 5 questions in a set must use the same two answer choices in op1/op2.`);
      }
    }
  }

  if (errors.length) {
    const err = new Error("Question set validation failed.");
    err.details = errors;
    throw err;
  }
}

function groupFinalQuestions(questions) {
  const groups = new Map();
  for (const q of questions.filter(x => x.type === "final-round")) {
    if (!groups.has(q.id)) groups.set(q.id, []);
    groups.get(q.id).push(q);
  }
  return [...groups.entries()].map(([id, qs]) => ({
    id,
    category: qs[0].category,
    questions: qs
  }));
}

function publicGame(game) {
  return {
    code: game.code,
    status: game.status,
    winnerId: game.winnerId || null,
    winnerName: game.winnerId ? game.players.get(game.winnerId)?.name || null : null,
    categories: game.categories,
    players: [...game.players.values()].map(p => ({
      id: p.id, name: p.name, score: p.score, wedges: p.wedges || [], connected: p.connected
    })),
    roundIndex: game.roundIndex,
    round: game.rounds[game.roundIndex] || null,
    questionIndex: game.questionIndex,
    questionCount: game.currentQuestions.length,
    question: game.currentPublicQuestion,
    revealed: game.revealed,
    answer: game.revealed ? game.currentAnswer : null,
    turnPlayerId: game.turnOrder[game.turnIndex] || null,
    turnPlayerName: game.turnOrder[game.turnIndex] ? game.players.get(game.turnOrder[game.turnIndex])?.name || null : null,
    switchagoriesTurn: game.switchagoriesTurn || null,
    switchagoriesCategoryChoices: game.switchagoriesCategoryChoices || [],
    finalCategoryIndex: game.finalCategoryIndex ?? null,
    finalCategoryCount: game.finalGroups?.length || 0,
    finalCategoryName: (() => {
      const key = game.finalGroups?.[game.finalCategoryIndex]?.category;
      const match = game.categories.find(c =>
        normalizeCategory(c.name) === normalizeCategory(key) ||
        normalizeCategory(c.color) === normalizeCategory(key)
      );
      return match?.name || key || null;
    })(),
    finalCategoryResolved: !!game.finalCategoryResolved,
    finalCategoryWinnerId: game.finalCategoryWinner || null,
    eliminatedPlayerIds: [...new Set([...(game.eliminated || []), ...(game.finalEliminated || [])])],
    timerSeconds: game.timerEndsAt ? Math.max(0, Math.ceil((game.timerEndsAt - Date.now()) / 1000)) : 0,
    timerEndsAt: game.timerEndsAt,
    notice: game.notice || null,
    scores: [...game.players.values()].map(p => ({ id:p.id, name:p.name, score:p.score, wedges:p.wedges || [] })),
    // Expose the selections made during the current question so the host
    // screen can show who picked what. Correctness is hidden until reveal,
    // except Grab Bag where a selection is immediately known to be right/wrong.
    answerSelections: game.rounds[game.roundIndex] === "Grab Bag"
      ? (game.selectionHistory || []).map(s => ({
          playerId: s.playerId,
          playerName: game.players.get(s.playerId)?.name || "Player",
          value: s.value,
          correct: s.correct
        }))
      : [...game.answers.entries()].filter(([, value]) => value).map(([playerId, value]) => ({
          playerId,
          playerName: game.players.get(playerId)?.name || "Player",
          value,
          correct: game.revealed ? (game.rounds[game.roundIndex] === "Close Call"
            ? game.currentAnswer.includes(value)
            : value === game.currentAnswer) : null
        })),
    // Only Grab Bag and Close Call lock answer choices across players.
    // Quickstarter, Switchagories, and Final Round are independent-answer rounds:
    // every player may select the same option as another player.
    claimedAnswers: ["Grab Bag", "Close Call"].includes(game.rounds[game.roundIndex])
      ? (game.rounds[game.roundIndex] === "Grab Bag"
          ? (game.claimedAnswers || {})
          : [...game.answers.entries()].reduce((out, [playerId, value]) => {
              if (value) out[value] = playerId;
              return out;
            }, {}))
      : {}
  };
}

function makePublicQuestion(q, round, finalOrder) {
  if (!q) return null;
  let options;
  if (q.type === "final-round") {
    options = finalOrder;
  } else {
    options = shuffle(q.options);
  }

  return {
    id: q.id,
    category: q.category,
    type: q.type,
    round,
    question: q.question,
    options,
    interaction: round === "Grab Bag" ? "grab-bag" :
      round === "Close Call" ? "close-call" :
      round === "Final Round" ? "final-round" :
      round === "Switchagories" ? "switchagories" : "multi-choice"
  };
}


const ROUND_CONFIG = {
  "Quickstarter": { count: 5, timer: 30 },
  "Grab Bag": { count: 5, timer: 30 },
  "Switchagories": { timer: 30 },
  "Close Call": { count: 5, timer: 30 },
  "Final Round": { count: 5, timer: 30 }
};

function stopTimer(game) {
  if (game.timerHandle) clearTimeout(game.timerHandle);
  game.timerHandle = null;
  game.timerEndsAt = null;
}

function startTimer(game) {
  stopTimer(game);
  const seconds = ROUND_CONFIG[game.rounds[game.roundIndex]]?.timer || 10;
  game.timerSeconds = seconds;
  game.timerEndsAt = Date.now() + seconds * 1000;
  game.timerHandle = setTimeout(() => {
    if (game.status !== "playing" || game.revealed) return;
    const round = game.rounds[game.roundIndex];
    if (round === "Grab Bag") {
      // A Grab Bag timeout counts as an incorrect selection and eliminates the
      // current player for the remainder of this question.
      const currentPlayerId = game.turnOrder[game.turnIndex];
      if (currentPlayerId) game.eliminated.add(currentPlayerId);
      advanceTurn(game);
    } else if (round === "Close Call") {
      // A timeout counts as the player's one turn without selecting a choice.
      // Record it so the round can reveal once every player has had a turn.
      const currentPlayerId = game.turnOrder[game.turnIndex];
      if (currentPlayerId && !game.answers.has(currentPlayerId)) game.answers.set(currentPlayerId, null);
      if (game.answers.size >= game.players.size) revealQuestion(game);
      else advanceTurn(game);
    }
    else if (round === "Switchagories" && game.currentPublicQuestion) revealQuestion(game);
    else if (round === "Switchagories") advanceTurn(game);
    else revealQuestion(game);
  }, seconds * 1000);
}

function initializeTurnState(game) {
  game.eliminated = new Set();
  game.answers = new Map();
  game.selectionHistory = [];
  game.claimedAnswers = {};
  game.switchagoriesCategoryChoices = [];

  const round = game.rounds[game.roundIndex];
  const ids = [...game.players.keys()];
  if (round === "Switchagories") {
    // Switchagories is always seat/player order, twice through the lineup.
    game.turnOrder = [...ids, ...ids];
  } else if (round === "Grab Bag" || round === "Close Call") {
    // At the start of every question, last place answers first and first place answers last.
    // Ties retain the players' original join order.
    const seatOrder = new Map(ids.map((id, index) => [id, index]));
    game.turnOrder = ids.sort((a, b) => {
      const pa = game.players.get(a);
      const pb = game.players.get(b);
      return (pa.score - pb.score) || (seatOrder.get(a) - seatOrder.get(b));
    });
  } else {
    // Quickstarter and Final Round are simultaneous.
    game.turnOrder = ids;
  }
  game.turnIndex = 0;
}

function addScore(game, playerId, points, category = null) {
  const p = game.players.get(playerId);
  if (!p) return;
  p.score += points;
  if (category && game.roundIndex < 4) checkScoreWedges(game, playerId, category);
}

function awardFinalWedge(game, playerId, category) {
  const p = game.players.get(playerId);
  if (!p || p.wedges.length >= 6) return false;
  const color = categoryColor(game, category);
  p.wedges.push(color);
  return true;
}

function someoneHasSixWedges(game) {
  return [...game.players.values()].some(p => (p.wedges || []).length >= 6);
}

function finalizeGame(game) {
  stopTimer(game);
  const candidates = [...game.players.values()].filter(p => (p.wedges || []).length >= 6);
  const pool = candidates.length ? candidates : [...game.players.values()];
  pool.sort((a, b) => (b.wedges.length - a.wedges.length) || (b.score - a.score));
  game.winnerId = pool[0]?.id || null;
  game.status = "finished";
  game.notice = game.winnerId ? `Game over — ${game.players.get(game.winnerId)?.name || "Winner"} wins.` : "Game over.";
  game.currentPublicQuestion = null;
  game.currentAnswer = null;
}

function advanceTurn(game) {
  const n = game.turnOrder.length;
  for (let i = 1; i <= n; i++) {
    const next = (game.turnIndex + i) % n;
    const id = game.turnOrder[next];
    if (!game.eliminated.has(id) && game.players.has(id)) {
      game.turnIndex = next;
      startTimer(game);
      emitState(game);
      return;
    }
  }
  revealQuestion(game);
}

function revealQuestion(game) {
  if (game.revealed) return;
  stopTimer(game);
  game.revealed = true;
  const round = game.rounds[game.roundIndex];

  if (round === "Quickstarter") {
    const points = [200, 400, 600, 800, 1000][game.questionIndex] || 0;
    for (const [playerId, answer] of game.answers.entries()) {
      if (answer === game.currentAnswer) addScore(game, playerId, points, game.currentPublicQuestion.category);
    }
  } else if (round === "Switchagories") {
    const points = game.switchagoriesTurn?.category === game.currentPublicQuestion.category ? 1800 : 900;
    for (const [playerId, answer] of game.answers.entries()) {
      if (answer === game.currentAnswer) addScore(game, playerId, points, game.currentPublicQuestion.category);
    }
  } else if (round === "Final Round") {
    const activeBefore = [...game.players.keys()].filter(id => !game.finalEliminated.has(id));
    const correctPlayers = [];

    for (const playerId of activeBefore) {
      const answer = game.answers.get(playerId);
      if (answer === game.currentAnswer) {
        correctPlayers.push(playerId);
        addScore(game, playerId, 1000);
        const count = game.finalCategoryCorrect.get(playerId) || 0;
        game.finalCategoryCorrect.set(playerId, count + 1);
      }
    }

    // Nobody gets eliminated when every remaining player misses the question.
    // A timeout is treated exactly like an incorrect answer.
    if (correctPlayers.length === 0) {
      if (game.questionIndex === game.currentQuestions.length - 1) {
        // The category is won by every player still standing when the last question
        // produces no correct answers.
        const category = game.finalGroups[game.finalCategoryIndex]?.category;
        for (const playerId of activeBefore) awardFinalWedge(game, playerId, category);
        game.finalCategoryResolved = true;
      }
    } else {
      for (const playerId of activeBefore) {
        if (!correctPlayers.includes(playerId)) game.finalEliminated.add(playerId);
      }
    }

    const category = game.finalGroups[game.finalCategoryIndex]?.category;
    // Any player who gets all five questions correct wins this category.
    for (const playerId of correctPlayers) {
      if ((game.finalCategoryCorrect.get(playerId) || 0) === 5) {
        awardFinalWedge(game, playerId, category);
        game.finalCategoryWinner = playerId;
        game.finalCategoryResolved = true;
      }
    }

    // If one player remains, award the category wedge and move on immediately.
    const active = [...game.players.keys()].filter(id => !game.finalEliminated.has(id));
    if (active.length === 1 && !game.finalCategoryResolved) {
      awardFinalWedge(game, active[0], category);
      game.finalCategoryWinner = active[0];
      game.finalCategoryResolved = true;
    }

    if (someoneHasSixWedges(game)) finalizeGame(game);
    else if (game.finalCategoryResolved) queueFinalCategoryAdvance(game);
  } else if (round === "Close Call") {
    const points = game.roundIndex === 1
      ? [1200, 1000, 800, 600, 0]
      : [2400, 2000, 1600, 1200, 0];
    for (const [playerId, answer] of game.answers.entries()) {
      if (!answer) continue;
      const rank = game.currentAnswer.indexOf(answer);
      if (rank >= 0) addScore(game, playerId, points[rank], game.currentPublicQuestion.category);
    }
  } else if (round === "Grab Bag") {
    // Grab Bag scores each correct selection immediately when it is made.
    // Nothing is scored again during the reveal.
  }

  if (someoneHasSixWedges(game)) {
    finalizeGame(game);
  }
  emitState(game);
}

function startQuestion(game) {
  const q = game.currentQuestions[game.questionIndex];
  if (!q) return finishRound(game);

  if (q.type === "final-round" && !game.finalOrderById[q.id]) {
    game.finalOrderById[q.id] = shuffle(q.options);
  }

  const finalOrder = q.type === "final-round" ? game.finalOrderById[q.id] : null;
  game.currentPublicQuestion = makePublicQuestion(q, game.rounds[game.roundIndex], finalOrder);
  game.currentAnswer = q.type === "close-call"
    ? parsePipe(q.answer)
    : q.type === "grab-bag"
      ? parsePipe(q.answer)
      : q.answer;
  game.revealed = false;
  game.selectionHistory = [];
  game.claimedAnswers = {};
  if (game.rounds[game.roundIndex] === "Final Round" && game.questionIndex === 0) {
    game.finalEliminated = new Set();
    game.finalCategoryCorrect = new Map();
    game.finalCategoryWinner = null;
    game.finalCategoryResolved = false;
  }
  if (game.rounds[game.roundIndex] === "Final Round" && game.questionIndex > 0) {
    // Keep eliminations and five-question correctness counts within the category.
    game.answers = new Map();
    game.revealed = false;
  }
  initializeTurnState(game);

  if (game.rounds[game.roundIndex] === "Switchagories") {
    game.switchagoriesTurn = { playerId: game.turnOrder[0] || null, category: null };
    game.currentPublicQuestion = null;
    game.currentAnswer = null;
    stopTimer(game);
    game.timerSeconds = 0;
    game.timerEndsAt = null;
  } else {
    startTimer(game);
  }
}

function uniqueCategoryQuestions(game, type, count) {
  const byCategory = new Map();
  for (const q of game.questionBank.filter(q => q.type === type)) {
    if (!byCategory.has(q.category)) byCategory.set(q.category, []);
    byCategory.get(q.category).push(q);
  }
  const categories = shuffle([...byCategory.keys()]);
  if (categories.length < count) {
    throw new Error(`${type} needs at least ${count} different categories.`);
  }
  return categories.slice(0, count).map(category => shuffle(byCategory.get(category))[0]);
}

function questionsForRound(game, round) {
  if (round === "Quickstarter") return uniqueCategoryQuestions(game, "multi-choice", 5);
  if (round === "Grab Bag") return uniqueCategoryQuestions(game, "grab-bag", 5);
  if (round === "Switchagories") return [];
  if (round === "Close Call") return uniqueCategoryQuestions(game, "close-call", 5);
  if (round === "Final Round") {
    const byCategory = new Map();
    for (const group of groupFinalQuestions(game.questionBank)) {
      if (!byCategory.has(group.category)) byCategory.set(group.category, []);
      byCategory.get(group.category).push(group);
    }
    const categories = shuffle([...byCategory.keys()]);
    game.finalGroups = categories.map(category => shuffle(byCategory.get(category))[0]);
    return game.finalGroups[0]?.questions || [];
  }
  return [];
}

function startSwitchagoriesRound(game) {
  // Switchagories is a dedicated Round 3. It has no question until the
  // current player chooses a category, then that player answers one
  // multi-choice question. The player order runs twice through the lineup.
  game.currentQuestions = [];
  game.questionIndex = 0;
  game.currentPublicQuestion = null;
  game.currentAnswer = null;
  game.revealed = false;
  game.selectionHistory = [];
  game.claimedAnswers = {};
  game.switchagoriesUsedQuestionIds = game.switchagoriesUsedQuestionIds || [];
  initializeTurnState(game);
  game.switchagoriesTurn = { playerId: game.turnOrder[0] || null, category: null };
  stopTimer(game);
  game.timerSeconds = 0;
  game.timerEndsAt = null;
}

function startSwitchagoriesQuestion(game, category) {
  const playerId = game.turnOrder[game.turnIndex];
  if (!playerId || !category) return;

  const categoryKey = normalizeCategory(category);
  const candidates = game.questionBank.filter(q => q.type === "multi-choice" && q.category === categoryKey);
  if (!candidates.length) return;

  const usedIds = new Set(game.switchagoriesUsedQuestionIds || []);
  const available = candidates.filter(q => !usedIds.has(q.id));
  const pool = available.length ? available : candidates;
  const q = shuffle(pool)[0];
  game.switchagoriesUsedQuestionIds ||= [];
  game.switchagoriesUsedQuestionIds.push(q.id);

  game.currentQuestions = [q];
  game.questionIndex = 0;
  game.currentPublicQuestion = makePublicQuestion(q, "Switchagories");
  game.currentAnswer = q.answer;
  game.revealed = false;
  game.answers = new Map();
  game.eliminated = new Set();
  game.switchagoriesTurn = { playerId, category: categoryKey };
  startTimer(game);
}

function queueFinalCategoryAdvance(game) {
  if (game.finalAdvanceHandle || game.status !== "playing" || someoneHasSixWedges(game)) return;
  game.finalAdvanceHandle = setTimeout(() => {
    game.finalAdvanceHandle = null;
    if (game.status !== "playing" || game.rounds[game.roundIndex] !== "Final Round" || !game.finalCategoryResolved) return;
    finishRound(game);
  }, 1200);
}

function finishRound(game) {
  stopTimer(game);
  if (game.finalAdvanceHandle) { clearTimeout(game.finalAdvanceHandle); game.finalAdvanceHandle = null; }
  if (game.rounds[game.roundIndex] === "Final Round") {
    const currentCategory = game.finalGroups[game.finalCategoryIndex]?.category;
    const active = [...game.players.keys()].filter(id => !game.finalEliminated.has(id));

    if (someoneHasSixWedges(game)) {
      finalizeGame(game);
      io.to(game.code).emit("state", publicGame(game));
      return;
    }

    // A resolved category ends immediately and the game proceeds to the next category.
    if (game.finalCategoryResolved || active.length === 1) {
      if (active.length === 1 && !game.finalCategoryResolved) {
        awardFinalWedge(game, active[0], currentCategory);
        game.finalCategoryResolved = true;
      }
      const nextCategoryIndex = (game.finalCategoryIndex ?? 0) + 1;
      if (nextCategoryIndex >= game.finalGroups.length) {
        finalizeGame(game);
        io.to(game.code).emit("state", publicGame(game));
        return;
      }
      game.finalCategoryIndex = nextCategoryIndex;
      game.finalCategoryResolved = false;
      game.finalCategoryWinner = null;
      game.notice = `Final Round: ${game.finalGroups[nextCategoryIndex].category}`;
      game.currentQuestions = game.finalGroups[nextCategoryIndex].questions;
      game.questionIndex = 0;
      startQuestion(game);
      io.to(game.code).emit("state", publicGame(game));
      return;
    }

    const nextCategoryIndex = (game.finalCategoryIndex ?? 0) + 1;
    if (nextCategoryIndex >= game.finalGroups.length) {
      finalizeGame(game);
      io.to(game.code).emit("state", publicGame(game));
      return;
    }
    game.finalCategoryIndex = nextCategoryIndex;
    game.finalCategoryResolved = false;
    game.finalCategoryWinner = null;
    game.notice = `Final Round: ${game.finalGroups[nextCategoryIndex].category}`;
    game.currentQuestions = game.finalGroups[nextCategoryIndex].questions;
    game.questionIndex = 0;
    startQuestion(game);
    io.to(game.code).emit("state", publicGame(game));
    return;
  }

  if (game.roundIndex >= game.rounds.length - 1) {
    game.status = "finished";
    game.currentPublicQuestion = null;
    game.currentAnswer = null;
    io.to(game.code).emit("state", publicGame(game));
    return;
  }

  game.roundIndex += 1;
  game.notice = `${game.rounds[game.roundIndex]} begins.`;
  game.questionIndex = 0;

  if (game.rounds[game.roundIndex] === "Switchagories") {
    startSwitchagoriesRound(game);
  } else {
    game.currentQuestions = questionsForRound(game, game.rounds[game.roundIndex]);
    startQuestion(game);
  }
  io.to(game.code).emit("state", publicGame(game));
}

function emitState(game) {
  io.to(game.code).emit("state", publicGame(game));
}

app.post("/api/games", express.json(), (req, res) => {
  const code = makeCode();
  const game = {
    code,
    status: "lobby",
    hostId: null,
    categories: DEFAULT_CATEGORIES.map(x => ({ ...x })),
    questionBank: [],
    players: new Map(),
    rounds: ["Quickstarter", "Grab Bag", "Switchagories", "Close Call", "Final Round"],
    roundIndex: 0,
    questionIndex: 0,
    currentQuestions: [],
    currentPublicQuestion: null,
    currentAnswer: null,
    finalOrderById: {},
    finalGroups: [],
    finalCategoryIndex: 0,
    finalEliminated: new Set(),
    finalCategoryCorrect: new Map(),
    finalCategoryWinner: null,
    finalCategoryResolved: false,
    finalAdvanceHandle: null,
    winnerId: null,
    switchagoriesUsedQuestionIds: [],
    switchagoriesTurn: null,
    switchagoriesCategoryChoices: [],
    revealed: false,
    answers: new Map(),
    selectionHistory: [],
    claimedAnswers: {},
    eliminated: new Set(),
    turnIndex: 0,
    turnOrder: [],
    timerSeconds: 10,
    timerEndsAt: null,
    timerHandle: null,
    notice: null,
    hostToken: makeToken(),
    reconnectTimers: new Map()
  };
  games.set(code, game);
  res.json({ code, hostToken: game.hostToken });
});

app.post("/api/games/:code/questions", upload.single("workbook"), (req, res) => {
  const game = games.get(req.params.code.toUpperCase());
  if (!game) return res.status(404).json({ error: "Game not found." });
  if (!req.file) return res.status(400).json({ error: "No workbook uploaded." });

  try {
    const parsed = parseWorkbook(req.file.buffer);
    game.categories = parsed.categories.map((c, i) => ({
      color: c.color || DEFAULT_CATEGORIES[i]?.color || `Color ${i + 1}`,
      name: c.name || DEFAULT_CATEGORIES[i]?.name || `Category ${i + 1}`
    }));
    // Normalize every question to the workbook category name so later host
    // renames continue to work consistently across all rounds.
    game.questionBank = parsed.questions.map(q => {
      const match = game.categories.find(c =>
        normalizeCategory(c.name) === q.category || normalizeCategory(c.color) === q.category
      );
      return { ...q, category: match ? normalizeCategory(match.name) : q.category };
    });
    res.json({
      ok: true,
      categories: game.categories,
      questionCount: game.questionBank.length,
      finalGroups: groupFinalQuestions(game.questionBank).length
    });
    emitState(game);
  } catch (error) {
    res.status(400).json({ error: error.message, details: error.details || [] });
  }
});

io.on("connection", socket => {
  socket.on("host:create", ({ code, hostToken } = {}, ack = () => {}) => {
    const game = games.get(String(code || "").toUpperCase());
    if (!game) return ack({ ok: false, error: "Game not found." });
    if (hostToken !== game.hostToken) return ack({ ok: false, error: "Invalid host session." });
    if (game.hostId && game.hostId !== socket.id) return ack({ ok: false, error: "A host is already connected." });
    game.hostId = socket.id;
    socket.join(game.code);
    socket.data.gameCode = game.code;
    socket.data.role = "host";
    ack({ ok: true, state: publicGame(game) });
    emitState(game);
  });

  socket.on("player:join", ({ code, name, reconnectToken } = {}, ack = () => {}) => {
    const game = games.get(String(code || "").toUpperCase());
    const playerName = clean(name).slice(0, 24);
    if (!game) return ack({ ok: false, error: "Game not found." });

    // Reconnect an existing player using their private token. This works even after the game starts.
    if (reconnectToken) {
      const existing = [...game.players.values()].find(p => p.reconnectToken === reconnectToken);
      if (existing) {
        existing.connected = true;
        existing.socketId = socket.id;
        const pending = game.reconnectTimers.get(existing.id);
        if (pending) clearTimeout(pending);
        game.reconnectTimers.delete(existing.id);
        socket.join(game.code);
        socket.data.gameCode = game.code;
        socket.data.role = "player";
        socket.data.playerId = existing.id;
        ack({ ok: true, playerId: existing.id, reconnectToken: existing.reconnectToken, state: publicGame(game), reconnected: true });
        emitState(game);
        return;
      }
    }

    if (!playerName) return ack({ ok: false, error: "Enter a player name." });
    if (game.status !== "lobby") return ack({ ok: false, error: "This game has already started." });

    const duplicate = [...game.players.values()].some(p => p.name.toLowerCase() === playerName.toLowerCase());
    if (duplicate) return ack({ ok: false, error: "That player name is already taken." });

    const playerId = crypto.randomUUID();
    const reconnectTokenForPlayer = makeToken();
    const player = { id: playerId, socketId: socket.id, reconnectToken: reconnectTokenForPlayer, name: playerName, score: 0, wedges: [], scoreWedgesAwarded: 0, connected: true };
    game.players.set(playerId, player);
    socket.join(game.code);
    socket.data.gameCode = game.code;
    socket.data.role = "player";
    socket.data.playerId = playerId;
    ack({ ok: true, playerId, reconnectToken: reconnectTokenForPlayer, state: publicGame(game) });
    emitState(game);
  });

  socket.on("host:start", (_, ack = () => {}) => {
    const game = games.get(socket.data.gameCode);
    if (!game || game.hostId !== socket.id) return ack({ ok: false, error: "Not authorized." });
    if (!game.questionBank.length) return ack({ ok: false, error: "Upload a valid question workbook first." });
    if (!game.players.size) return ack({ ok: false, error: "At least one player must join." });

    game.status = "playing";
    game.notice = "Game started.";
    // Round 2 is one of Grab Bag or Close Call; Round 4 is the other.
    // Switchagories is always Round 3.
    const roundTwo = Math.random() < 0.5 ? "Grab Bag" : "Close Call";
    const roundFour = roundTwo === "Grab Bag" ? "Close Call" : "Grab Bag";
    game.rounds = ["Quickstarter", roundTwo, "Switchagories", roundFour, "Final Round"];
    game.roundIndex = 0;
    game.questionIndex = 0;
    game.finalOrderById = {};
    game.finalGroups = [];
    game.finalCategoryIndex = 0;
    game.winnerId = null;
    game.switchagoriesUsedQuestionIds = [];
    game.switchagoriesTurn = null;
    game.switchagoriesCategoryChoices = [];
    for (const p of game.players.values()) { p.score = 0; p.wedges = []; p.scoreWedgesAwarded = 0; }
    try {
      game.currentQuestions = questionsForRound(game, game.rounds[0]);
      startQuestion(game);
      ack({ ok: true });
      emitState(game);
    } catch (error) {
      game.status = "lobby";
      ack({ ok: false, error: error.message });
    }
  });

  socket.on("player:switch-category", ({ category } = {}, ack = () => {}) => {
    const game = games.get(socket.data.gameCode);
    const player = game?.players.get(socket.data.playerId);
    if (!game || !player || game.status !== "playing" || game.rounds[game.roundIndex] !== "Switchagories") {
      return ack({ ok: false, error: "Category selection is not available." });
    }
    if (game.turnOrder[game.turnIndex] !== socket.data.playerId) {
      return ack({ ok: false, error: "It is not your turn." });
    }
    if (game.currentPublicQuestion) {
      return ack({ ok: false, error: "A question is already active." });
    }

    const categoryKey = normalizeCategory(category);
    if (!game.categories.some(c => normalizeCategory(c.name) === categoryKey)) {
      return ack({ ok: false, error: "Invalid category." });
    }
    const exists = game.questionBank.some(q => q.type === "multi-choice" && q.category === categoryKey);
    if (!exists) return ack({ ok: false, error: "There are no Switchagories questions for that category." });

    game.switchagoriesCategoryChoices.push({ playerId: socket.data.playerId, category: categoryKey });
    startSwitchagoriesQuestion(game, categoryKey);
    ack({ ok: true });
    emitState(game);
  });

  socket.on("player:answer", ({ value } = {}, ack = () => {}) => {
    const game = games.get(socket.data.gameCode);
    const player = game?.players.get(socket.data.playerId);
    if (!game || !player || game.status !== "playing" || game.revealed) {
      return ack({ ok: false, error: "Answers are not being accepted." });
    }

    const round = game.rounds[game.roundIndex];
    if (round === "Final Round" && game.finalEliminated.has(socket.data.playerId)) {
      return ack({ ok: false, error: "You are out for this Final Round category." });
    }
    if ((round === "Grab Bag" || round === "Close Call" || round === "Switchagories") && game.turnOrder[game.turnIndex] !== socket.data.playerId) {
      return ack({ ok: false, error: "It is not your turn." });
    }

    const answer = clean(value);
    if (!game.currentPublicQuestion?.options.includes(answer)) {
      return ack({ ok: false, error: "Invalid answer." });
    }

    if (round === "Grab Bag") {
      // Grab Bag answers are an unordered set. Every option listed in the
      // workbook's answer cell is correct, regardless of its position.
      if (game.claimedAnswers[answer]) {
        return ack({ ok: false, error: "That answer choice has already been selected." });
      }

      const correct = game.currentAnswer.includes(answer);
      game.claimedAnswers[answer] = socket.data.playerId;
      game.selectionHistory.push({ playerId: socket.data.playerId, value: answer, correct });

      const points = game.roundIndex === 1 ? 300 : 1200;
      if (correct) {
        addScore(game, socket.data.playerId, points, game.currentPublicQuestion.category);
        ack({ ok: true, result: "correct" });
      } else {
        game.eliminated.add(socket.data.playerId);
        ack({ ok: true, result: "wrong" });
      }

      // Correct players remain eligible and can come back around for another
      // selection. Incorrect players are eliminated for this question.
      advanceTurn(game);
      return;
    }

    if (round === "Close Call") {
      const rank = game.currentAnswer.indexOf(answer);
      // A Close Call choice can only be claimed once.
      if ([...game.answers.values()].includes(answer)) {
        return ack({ ok: false, error: "That answer choice has already been selected." });
      }
      game.answers.set(socket.data.playerId, answer);
      ack({ ok: true, result: rank === 0 ? "top" : "selected" });
      if (game.answers.size >= game.players.size) revealQuestion(game);
      else advanceTurn(game);
      return;
    }

    if (round === "Switchagories") {
      game.answers.set(socket.data.playerId, answer);
      ack({ ok: true, result: answer === game.currentAnswer ? "correct" : "wrong" });
      revealQuestion(game);
      return;
    }

    game.answers.set(socket.data.playerId, answer);
    ack({ ok: true });
    const expectedAnswers = round === "Final Round"
      ? [...game.players.keys()].filter(id => !game.finalEliminated.has(id)).length
      : game.players.size;
    if (game.answers.size >= expectedAnswers) revealQuestion(game);
    else emitState(game);
  });

  socket.on("host:reveal", (_, ack = () => {}) => {
    const game = games.get(socket.data.gameCode);
    if (!game || game.hostId !== socket.id) return ack({ ok: false, error: "Not authorized." });
    revealQuestion(game);
    ack({ ok: true });
  });

  socket.on("host:next", (_, ack = () => {}) => {
    const game = games.get(socket.data.gameCode);
    if (!game || game.hostId !== socket.id) return ack({ ok: false, error: "Not authorized." });
    if (!game.revealed) return ack({ ok: false, error: "Reveal the answer first." });

    const round = game.rounds[game.roundIndex];

    if (round === "Final Round" && game.finalCategoryResolved) {
      finishRound(game);
    } else if (round === "Final Round" && game.questionIndex + 1 >= game.currentQuestions.length) {
      finishRound(game);
    } else if (round === "Switchagories") {
      game.questionIndex = 0;
      game.turnIndex += 1;
      if (game.turnIndex >= game.turnOrder.length) {
        finishRound(game);
      } else {
        game.currentPublicQuestion = null;
        game.currentAnswer = null;
        game.revealed = false;
        game.switchagoriesTurn = { playerId: game.turnOrder[game.turnIndex], category: null };
        game.switchagoriesCategoryChoices = [];
        stopTimer(game);
      }
    } else {
      game.questionIndex += 1;
      if (game.questionIndex >= game.currentQuestions.length) {
        finishRound(game);
      } else {
        startQuestion(game);
      }
    }
    ack({ ok: true });
    emitState(game);
  });

  socket.on("host:skip-turn", (_, ack = () => {}) => {
    const game = games.get(socket.data.gameCode);
    if (!game || game.hostId !== socket.id) return ack({ ok: false, error: "Not authorized." });
    const round = game.rounds[game.roundIndex];
    if (game.revealed || !["Grab Bag","Close Call","Switchagories"].includes(round)) {
      return ack({ ok: false, error: "Skip turn is only available during turn-based rounds." });
    }
    if (round === "Switchagories") {
      game.currentPublicQuestion = null;
      game.currentAnswer = null;
      game.turnIndex += 1;
      if (game.turnIndex >= game.turnOrder.length) finishRound(game);
      else {
        game.switchagoriesTurn = { playerId: game.turnOrder[game.turnIndex], category: null };
        game.switchagoriesCategoryChoices = [];
        emitState(game);
      }
    } else {
      advanceTurn(game);
    }
    ack({ ok: true });
  });

  socket.on("host:categories", ({ categories } = {}, ack = () => {}) => {
    const game = games.get(socket.data.gameCode);
    if (!game || game.hostId !== socket.id || !Array.isArray(categories) || categories.length !== 6) {
      return ack({ ok: false, error: "Invalid category update." });
    }
    const oldCategories = game.categories.map(c => ({ ...c }));
    const updatedCategories = categories.slice(0, 6).map((c, i) => ({
      color: clean(c.color) || DEFAULT_CATEGORIES[i].color,
      name: clean(c.name) || DEFAULT_CATEGORIES[i].name
    }));
    game.questionBank = game.questionBank.map(q => {
      const oldIndex = oldCategories.findIndex(c =>
        normalizeCategory(c.name) === q.category || normalizeCategory(c.color) === q.category
      );
      return oldIndex >= 0 ? { ...q, category: normalizeCategory(updatedCategories[oldIndex].name) } : q;
    });
    game.categories = updatedCategories;
    ack({ ok: true });
    emitState(game);
  });

  socket.on("disconnect", () => {
    const game = games.get(socket.data.gameCode);
    if (!game) return;
    if (game.hostId === socket.id) {
      game.hostId = null;
      if (game.status === "lobby") emitState(game);
      return;
    }
    const playerId = socket.data.playerId;
    const player = playerId ? game.players.get(playerId) : null;
    if (!player || player.socketId !== socket.id) return;
    player.connected = false;
    player.socketId = null;

    if (["Grab Bag", "Close Call", "Switchagories"].includes(game.rounds[game.roundIndex]) && game.turnOrder[game.turnIndex] === playerId && !game.revealed) {
      const timer = setTimeout(() => {
        game.reconnectTimers.delete(playerId);
        const current = game.players.get(playerId);
        if (!current?.connected && game.status === "playing" && !game.revealed) {
          if (game.rounds[game.roundIndex] === "Switchagories") {
            game.turnIndex += 1;
            if (game.turnIndex >= game.turnOrder.length) finishRound(game);
            else {
              game.currentPublicQuestion = null;
              game.currentAnswer = null;
              game.switchagoriesTurn = { playerId: game.turnOrder[game.turnIndex], category: null };
              emitState(game);
            }
          } else {
            advanceTurn(game);
          }
        }
      }, RECONNECT_GRACE_MS);
      game.reconnectTimers.set(playerId, timer);
    }
    emitState(game);
  });
});

server.listen(PORT, () => {
  console.log(`Trivial Pursuit Live prototype running at http://localhost:${PORT}`);
});