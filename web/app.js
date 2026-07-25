import { BOARD_SIZE, Cell, Game, cloneState } from "./engine.js?v=0.11.7";
import {
  SAVE_VERSION,
  buildActiveSave,
  createMatchId,
  legacyMatchId,
} from "./save.js?v=0.11.7";
import {
  loadProgress,
  recordResult,
  recoverUltraProgress,
  saveProgress,
} from "./progress.js?v=0.11.7";
import { loadLanguage, saveLanguage, translate } from "./i18n.js?v=0.11.7";
import { beamPoints } from "./beam.js?v=0.11.7";
import { drawDetailKey } from "./result.js?v=0.11.7";

const SAVE_KEY = "laser-war.web.v1";
const BEAM_VISIBLE_MS = 920;
const game = new Game();

const elements = {
  menu: document.querySelector("#menu-screen"),
  gameScreen: document.querySelector("#game-screen"),
  board: document.querySelector("#board"),
  beams: document.querySelector("#beams"),
  status: document.querySelector("#status"),
  statusLight: document.querySelector("#status-light"),
  modeLabel: document.querySelector("#mode-label"),
  log: document.querySelector("#match-log"),
  matchMeta: document.querySelector("#match-meta"),
  moveCount: document.querySelector("#move-count"),
  aiDetail: document.querySelector("#ai-detail"),
  continueButton: document.querySelector("#continue-game"),
  copyLog: document.querySelector("#copy-log"),
  slash: document.querySelector("#select-slash"),
  backslash: document.querySelector("#select-backslash"),
  pauseOverlay: document.querySelector("#pause-overlay"),
  resultOverlay: document.querySelector("#result-overlay"),
  resultTitle: document.querySelector("#result-title"),
  resultDetail: document.querySelector("#result-detail"),
  toast: document.querySelector("#toast"),
  rules: document.querySelector("#rules-dialog"),
  sound: document.querySelector("#sound-toggle"),
  ultraDifficulty: document.querySelector("#ultra-difficulty"),
  ultraState: document.querySelector("#ultra-state"),
  progressNote: document.querySelector("#progress-note"),
};

let session = createSession();
let progress = loadProgress(localStorage);
let language = loadLanguage(localStorage);
let selectedMirror = Cell.SLASH;
let legalMoves = [];
let inputLocked = false;
let paused = false;
let lastOutcome = null;
let toastTimer = 0;
let aiWorker = null;
let aiRequestId = 0;
let aiTimer = 0;
let aiProgress = null;
let ultraUnlockedThisMatch = false;

function t(key, values = {}) {
  return translate(language, key, values);
}

function difficultyName(difficulty) {
  return t(difficulty);
}

function moveCount(count) {
  return `${count} ${t(count === 1 ? "move" : "moves")}`;
}

/** Format the original match start in the active language and local timezone. */
function matchDate() {
  const started = new Date(session.startedAt);
  if (Number.isNaN(started.getTime())) return session.startedAt;
  const locale = language === "fr" ? "fr-FR" : "en-CA";
  return new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(started);
}

/** Name both participants, including the selected computer difficulty. */
function matchupLabel() {
  if (session.mode === "computer") {
    return t("computerMatchup", { difficulty: difficultyName(session.difficulty) });
  }
  return t("localMatchup");
}

/** Build the localized date and participant line shared by the UI and clipboard. */
function matchMetadata() {
  return `${matchDate()} · ${matchupLabel()}`;
}

/** Create an empty browser match session with stable identity metadata. */
function createSession(
  mode = "computer",
  difficulty = "medium",
  id = createMatchId(),
  startedAt = new Date().toISOString(),
) {
  return {
    id,
    startedAt,
    mode,
    difficulty,
    state: game.initialState(),
    history: [],
    redo: [],
  };
}

function moveKey(move) {
  return `${move.row},${move.col},${move.mirror}`;
}

function humanTurn() {
  return session.mode === "local" || session.state.turn === "bottom";
}

function computerTurn() {
  return session.mode === "computer"
    && session.state.turn === "top"
    && !session.state.winner
    && !session.state.draw;
}

/** Read the selected difficulty while enforcing the Ultra lock. */
function currentDifficulty() {
  const selected = document.querySelector('input[name="difficulty"]:checked')?.value || "medium";
  return selected === "ultra" && !progress.ultraUnlocked ? "hard" : selected;
}

/** Replace the active session with a fresh match and optionally persist it. */
function startGame(mode, difficulty = currentDifficulty(), persist = true) {
  cancelComputerTurn();
  session = createSession(mode, difficulty);
  lastOutcome = null;
  ultraUnlockedThisMatch = false;
  startGameView();
  if (persist) saveGame();
}

/** Resolve, record, animate, and save one player or computer move. */
function playMove(move, actor) {
  if (inputLocked || paused || session.state.winner || session.state.draw) return;
  let outcome;
  try {
    outcome = game.resolveMove(session.state, move);
  } catch (error) {
    showToast(t("illegalMove"));
    return;
  }

  const before = cloneState(session.state);
  session.state = outcome.state;
  const record = {
    number: session.history.length + 1,
    actor,
    move: { ...move },
    before,
    after: cloneState(outcome.state),
    outcome,
  };
  session.history.push(record);
  session.redo = [];
  lastOutcome = outcome;
  inputLocked = true;
  refreshLegalMoves();
  render();
  renderBeams(outcome.beams);
  audio.play(outcome.destroyed.length ? "impact" : "laser");
  saveGame();
  const matchId = session.id;

  window.setTimeout(() => {
    if (session.id !== matchId || elements.gameScreen.hidden) return;
    inputLocked = false;
    render();
    if (session.state.winner || session.state.draw) {
      showResult();
    } else {
      clearBeams();
      if (computerTurn()) beginComputerTurn();
    }
  }, BEAM_VISIBLE_MS);
}

/** Lock input and submit the current position to the AI worker. */
function beginComputerTurn() {
  if (elements.gameScreen.hidden || !computerTurn() || inputLocked) return;
  cancelComputerTurn();
  inputLocked = true;
  elements.status.textContent = t("computerThinking");
  elements.statusLight.style.background = "var(--cyan)";
  elements.statusLight.style.color = "var(--cyan)";
  elements.aiDetail.classList.add("thinking");
  const started = performance.now();
  const difficulty = session.difficulty;
  aiProgress = difficulty === "ultra" ? { phase: "preparing", depth: 0, nodes: 0 } : null;
  renderAiProgress(difficulty, started);
  renderBoard();
  aiTimer = window.setInterval(() => {
    renderAiProgress(difficulty, started);
  }, 250);

  const requestId = ++aiRequestId;
  aiWorker = new Worker("./ai_worker.js?v=0.11.7", { type: "module" });
  aiWorker.addEventListener("message", ({ data }) => {
    if (data.requestId !== requestId || requestId !== aiRequestId) return;
    if (data.type === "progress") {
      aiProgress = data.progress;
      renderAiProgress(difficulty, started);
      return;
    }
    finishComputerTurn(data.result);
  });
  aiWorker.addEventListener("error", () => {
    if (requestId !== aiRequestId) return;
    cancelComputerTurn();
    inputLocked = false;
    render();
    showToast(t("computerSearchFailed"));
  });
  aiWorker.postMessage({ requestId, state: cloneState(session.state), difficulty });
}

/** Render genuine AI search progress rather than a generic activity message. */
function renderAiProgress(difficulty, started) {
  const seconds = ((performance.now() - started) / 1000).toFixed(1);
  if (difficulty !== "ultra") {
    elements.aiDetail.textContent = t("standardSearching", {
      difficulty: difficultyName(difficulty),
      seconds,
    });
    return;
  }
  elements.aiDetail.textContent = aiProgress?.phase === "searching"
    ? t("ultraSearching", {
      depth: aiProgress.depth,
      nodes: aiProgress.nodes.toLocaleString(language),
      seconds,
    })
    : t("ultraSearch");
}

/** Apply a still-current AI result or restart search when it became stale. */
function finishComputerTurn(result) {
  cancelComputerTurn(false);
  inputLocked = false;
  if (!computerTurn()) return;
  if (!result.move) {
    session.state.draw = true;
    saveGame();
    render();
    showResult();
    return;
  }
  elements.aiDetail.classList.remove("thinking");
  elements.aiDetail.textContent = t("aiResult", {
    depth: result.depth,
    nodes: result.nodes.toLocaleString(language),
    elapsed: formatElapsed(result.elapsed),
  });
  playMove(result.move, "computer");
}

/** Cancel timers and invalidate pending worker responses. */
function cancelComputerTurn(invalidate = true) {
  if (invalidate) aiRequestId += 1;
  window.clearInterval(aiTimer);
  aiTimer = 0;
  aiWorker?.terminate();
  aiWorker = null;
  aiProgress = null;
  elements.aiDetail?.classList.remove("thinking");
}

function formatElapsed(milliseconds) {
  return milliseconds >= 1000 ? `${(milliseconds / 1000).toFixed(1)} s` : `${Math.round(milliseconds)} ms`;
}

function refreshLegalMoves() {
  legalMoves = humanTurn() && !session.state.winner && !session.state.draw
    ? game.legalMoves(session.state)
    : [];
}

/** Refresh every dynamic section of the active match interface. */
function render() {
  renderMirrorSelection();
  renderBoard();
  renderStatus();
  renderLog();
}

/** Synchronize mirror controls with the active orientation. */
function renderMirrorSelection() {
  elements.slash.classList.toggle("selected", selectedMirror === Cell.SLASH);
  elements.backslash.classList.toggle("selected", selectedMirror === Cell.BACKSLASH);
}

/** Render all board cells with legal, explanatory, and terminal input states. */
function renderBoard() {
  const legal = new Set(legalMoves.map(moveKey));
  const forbidden = game.mirrorForbiddenSquares(session.state.board);
  elements.board.replaceChildren();

  for (let row = 0; row < BOARD_SIZE; row += 1) {
    for (let col = 0; col < BOARD_SIZE; col += 1) {
      const cell = document.createElement("button");
      const value = session.state.board[row][col];
      const move = { row, col, mirror: selectedMirror };
      const moveIsLegal = legal.has(moveKey(move));
      const canAct = humanTurn()
        && !inputLocked
        && !paused
        && !session.state.winner
        && !session.state.draw;
      const explainable = canAct && !moveIsLegal;
      cell.className = "cell";
      cell.dataset.row = String(row);
      cell.dataset.col = String(col);
      cell.setAttribute("role", "gridcell");
      cell.setAttribute("aria-label", cellLabel(row, col, value, moveIsLegal, explainable));
      if (forbidden.has(`${row},${col}`)) cell.classList.add("blocked");
      if (moveIsLegal && canAct) cell.classList.add("legal");
      if (explainable) cell.classList.add("explainable");
      cell.disabled = !canAct;
      cell.addEventListener("click", () => {
        if (moveIsLegal) {
          playMove(move, session.mode === "computer" ? "you" : session.state.turn);
        } else {
          explainIllegalMove(move);
        }
      });
      cell.addEventListener("mouseenter", () => {
        if (moveIsLegal && !cell.disabled) {
          cell.classList.add("preview");
          cell.style.setProperty("--mirror-angle", selectedMirror === Cell.SLASH ? "45deg" : "-45deg");
        }
      });
      cell.addEventListener("mouseleave", () => cell.classList.remove("preview"));
      if (value !== Cell.EMPTY) cell.append(pieceFor(value));
      elements.board.append(cell);
    }
  }
}

/** Build the visual token for one nonempty engine cell. */
function pieceFor(value) {
  const piece = document.createElement("span");
  piece.className = "piece";
  if (value === Cell.SLASH || value === Cell.BACKSLASH) {
    piece.classList.add("mirror");
    piece.style.setProperty("--mirror-angle", value === Cell.SLASH ? "45deg" : "-45deg");
  } else if (value === Cell.SHIELD) {
    piece.classList.add("shield");
  } else {
    piece.classList.add("king");
    piece.style.setProperty("--king-color", value === Cell.TOP_KING ? "var(--cyan)" : "var(--amber)");
    piece.style.setProperty("--king-fill", value === Cell.TOP_KING ? "#176f82" : "#8b5a12");
  }
  return piece;
}

/** Build a localized accessible label for one board cell. */
function cellLabel(row, col, value, moveIsLegal, explainable = false) {
  const names = {
    [Cell.EMPTY]: t("empty"),
    [Cell.SLASH]: t("slashMirror"),
    [Cell.BACKSLASH]: t("backslashMirror"),
    [Cell.SHIELD]: t("shield"),
    [Cell.TOP_KING]: t("topKing"),
    [Cell.BOTTOM_KING]: t("bottomKing"),
  };
  const mirror = selectedMirror === Cell.SLASH ? t("slashMirror") : t("backslashMirror");
  let action = "";
  if (moveIsLegal) action = t("placeAction", { mirror });
  else if (explainable) action = t("explainAction");
  return t("cellLabel", { row: row + 1, col: col + 1, cell: names[value], action });
}

/** Explain why a clicked illegal placement was rejected. */
function explainIllegalMove(move) {
  const reason = game.illegalMoveReason(session.state, move) || "illegalMove";
  showToast(t(reason));
}

/** Render the current turn, search, or terminal status. */
function renderStatus() {
  let text = "";
  let color = "var(--amber)";
  if (session.state.winner) {
    text = t("sideWins", { side: t(session.state.winner) });
    color = session.state.winner === "bottom" ? "var(--amber)" : "var(--cyan)";
  } else if (session.state.draw) {
    text = t("draw");
    color = "var(--muted)";
  } else if (inputLocked && computerTurn()) {
    text = t("computerThinking");
    color = "var(--cyan)";
  } else if (session.mode === "computer") {
    text = session.state.turn === "bottom" ? t("yourTurn") : t("computerTurn");
    color = session.state.turn === "bottom" ? "var(--amber)" : "var(--cyan)";
  } else {
    text = t("sideToMove", { side: t(session.state.turn) });
    color = session.state.turn === "bottom" ? "var(--amber)" : "var(--cyan)";
  }
  elements.status.textContent = text;
  elements.statusLight.style.background = color;
  elements.statusLight.style.color = color;
}

/** Rebuild the localized and scrollable current-match history. */
function renderLog() {
  elements.matchMeta.textContent = matchMetadata();
  elements.moveCount.textContent = moveCount(session.history.length);
  elements.copyLog.disabled = session.history.length === 0;
  elements.log.replaceChildren();
  if (!session.history.length) {
    const empty = document.createElement("li");
    empty.className = "empty-log";
    empty.textContent = t("emptyLog");
    elements.log.append(empty);
    return;
  }
  for (const record of session.history) {
    const item = document.createElement("li");
    item.textContent = recordSummary(record);
    elements.log.append(item);
  }
  elements.log.scrollTop = elements.log.scrollHeight;
}

/** Format one turn record for the active interface language. */
function recordSummary(record) {
  const effects = [];
  if (record.outcome.destroyed.length) {
    effects.push(t("shieldAt", {
      positions: record.outcome.destroyed.map(([row, col]) => positionLabel(row, col)).join(", "),
    }));
  }
  if (record.outcome.hitKings.size) {
    if (record.outcome.hitKings.size === 2) {
      effects.push(t("bothKingsHit"));
    } else {
      const [king] = record.outcome.hitKings;
      effects.push(t("singleKingHit", { king: t(`${king}King`) }));
    }
  }
  return t("record", {
    actor: actorLabel(record.actor),
    mirror: record.move.mirror,
    position: positionLabel(record.move.row, record.move.col),
    effects: effects.join(", ") || t("noDamage"),
  });
}

function positionLabel(row, col) {
  return t("rowColumn", { row: row + 1, col: col + 1 });
}

/** Normalize canonical and legacy actors for localized display. */
function actorLabel(actor) {
  const normalized = String(actor).toLowerCase();
  if (["you", "vous"].includes(normalized)) return t("you");
  if (["computer", "ordinateur"].includes(normalized)) return t("computer");
  if (["top", "haut", "joueur du haut"].includes(normalized)) return t("topPlayer");
  if (["bottom", "bas", "joueur du bas"].includes(normalized)) return t("bottomPlayer");
  return actor;
}

/** Draw both animated SVG beam paths from one resolved volley. */
function renderBeams(beams) {
  clearBeams();
  beams.forEach((beam, index) => {
    const points = beamPoints(beam, index);
    const pointString = points.map((point) => point.join(",")).join(" ");
    const color = index === 0 ? "var(--red)" : "var(--cyan)";
    for (const className of ["beam-glow", "beam-core"]) {
      const line = document.createElementNS("http://www.w3.org/2000/svg", "polyline");
      line.setAttribute("points", pointString);
      line.setAttribute("pathLength", "1");
      line.setAttribute("class", className);
      if (className === "beam-core") line.style.stroke = color;
      elements.beams.append(line);
    }
    if (beam.hitShield) {
      const [row, col] = beam.hitShield;
      const impact = document.createElementNS("http://www.w3.org/2000/svg", "circle");
      impact.setAttribute("cx", String(col * 100 + 50));
      impact.setAttribute("cy", String(row * 100 + 50));
      impact.setAttribute("r", "14");
      impact.setAttribute("class", "beam-impact");
      impact.style.setProperty("--beam-color", color);
      elements.beams.append(impact);
    }
  });
}

function clearBeams() {
  elements.beams.replaceChildren();
}

/** Reveal and populate the terminal result panel without covering the board. */
function showResult(playSound = true) {
  if (
    !ultraUnlockedThisMatch
    && recordResult(progress, {
      mode: session.mode,
      difficulty: session.difficulty,
      winner: session.state.winner,
    })
  ) {
    ultraUnlockedThisMatch = true;
    saveProgress(localStorage, progress);
    updateProgressUI();
  }
  elements.resultOverlay.hidden = false;
  elements.gameScreen.classList.add("match-complete");
  if (session.state.draw) {
    elements.resultTitle.textContent = t("draw").toUpperCase();
    elements.resultTitle.style.color = "var(--ink)";
    elements.resultDetail.textContent = t(
      drawDetailKey(lastOutcome),
      { count: moveCount(session.history.length) },
    );
  } else if (session.mode === "computer") {
    const victory = session.state.winner === "bottom";
    elements.resultTitle.textContent = victory ? t("victory") : t("defeat");
    elements.resultTitle.style.color = victory ? "var(--amber)" : "var(--cyan)";
    elements.resultDetail.textContent = ultraUnlockedThisMatch
      ? t("ultraUnlocked")
      : t("resultDetail", {
        difficulty: difficultyName(session.difficulty),
        count: moveCount(session.history.length),
      });
  } else {
    elements.resultTitle.textContent = t("sideWins", { side: t(session.state.winner) }).toUpperCase();
    elements.resultTitle.style.color = session.state.winner === "bottom" ? "var(--amber)" : "var(--cyan)";
    elements.resultDetail.textContent = moveCount(session.history.length);
  }
  if (playSound) audio.play("victory");
}

/** Undo exactly one move and refresh all derived state. */
function undo() {
  if (inputLocked || !session.history.length) return;
  cancelComputerTurn();
  const record = session.history.pop();
  session.redo.push(record);
  session.state = cloneState(record.before);
  lastOutcome = null;
  elements.resultOverlay.hidden = true;
  elements.gameScreen.classList.remove("match-complete");
  clearBeams();
  refreshLegalMoves();
  render();
  saveGame();
  audio.play("undo");
}

/** Revalidate and restore exactly one previously undone move. */
function redo() {
  if (inputLocked || !session.redo.length) return;
  cancelComputerTurn();
  const old = session.redo.pop();
  let outcome;
  try {
    outcome = game.resolveMove(session.state, old.move);
  } catch {
    showToast(t("redoFailed"));
    session.redo.push(old);
    return;
  }
  const record = {
    number: session.history.length + 1,
    actor: old.actor,
    move: { ...old.move },
    before: cloneState(session.state),
    after: cloneState(outcome.state),
    outcome,
  };
  session.history.push(record);
  session.state = outcome.state;
  lastOutcome = outcome;
  refreshLegalMoves();
  render();
  renderBeams(outcome.beams);
  saveGame();
  if (session.state.winner || session.state.draw) {
    showResult();
  } else {
    window.setTimeout(clearBeams, BEAM_VISIBLE_MS);
  }
}

function restart() {
  startGame(session.mode, session.difficulty);
}

/** Leave the active match and restore the main menu. */
function returnToMenu() {
  cancelComputerTurn();
  inputLocked = false;
  paused = false;
  elements.pauseOverlay.hidden = true;
  elements.resultOverlay.hidden = true;
  elements.gameScreen.classList.remove("match-complete");
  elements.gameScreen.hidden = true;
  elements.menu.hidden = false;
  elements.continueButton.disabled = !hasSave();
}

/** Toggle the modal pause state for an unfinished match. */
function togglePause() {
  if (elements.gameScreen.hidden || inputLocked || session.state.winner || session.state.draw) return;
  paused = !paused;
  elements.pauseOverlay.hidden = !paused;
  renderBoard();
}

/** Persist the active browser match and report unavailable storage. */
function saveGame() {
  try {
    localStorage.setItem(SAVE_KEY, JSON.stringify(buildActiveSave(session)));
    elements.continueButton.disabled = false;
  } catch {
    showToast(t("storageFailed"));
  }
}

/** Return whether browser storage contains a supported active save. */
function hasSave() {
  try {
    return JSON.parse(localStorage.getItem(SAVE_KEY))?.version === SAVE_VERSION;
  } catch {
    return false;
  }
}

/** Rebuild a saved session by replaying moves through current rules. */
function sessionFromSave(data) {
  if (data?.version !== SAVE_VERSION) throw new Error("Unsupported save.");
  const restored = createSession(
    data.mode,
    data.difficulty,
    data.matchId || legacyMatchId(data),
    data.startedAt || new Date().toISOString(),
  );
  for (const item of data.moves || []) {
    const before = cloneState(restored.state);
    const move = { row: item.row, col: item.col, mirror: item.mirror };
    const outcome = game.resolveMove(restored.state, move);
    restored.state = outcome.state;
    restored.history.push({
      number: restored.history.length + 1,
      actor: item.actor,
      move,
      before,
      after: cloneState(outcome.state),
      outcome,
    });
  }
  return restored;
}

/** Load the active save and restore terminal visuals or computer play. */
function continueGame() {
  try {
    const data = JSON.parse(localStorage.getItem(SAVE_KEY));
    session = sessionFromSave(data);
    if (session.difficulty === "ultra" && !progress.ultraUnlocked) {
      progress.ultraUnlocked = true;
      saveProgress(localStorage, progress);
      updateProgressUI();
    }
    startGameView();
    lastOutcome = session.history.at(-1)?.outcome || null;
    saveGame();
  } catch (error) {
    localStorage.removeItem(SAVE_KEY);
    elements.continueButton.disabled = true;
    returnToMenu();
    showToast(t("loadFailed", { error: error.message }));
    return;
  }
  if (session.state.winner || session.state.draw) {
    if (lastOutcome) renderBeams(lastOutcome.beams);
    showResult();
  } else if (computerTurn()) {
    beginComputerTurn();
  }
}

/** Initialize all controls and derived rendering for the active match. */
function startGameView() {
  selectedMirror = Cell.SLASH;
  inputLocked = false;
  paused = false;
  elements.menu.hidden = true;
  elements.gameScreen.hidden = false;
  elements.pauseOverlay.hidden = true;
  elements.resultOverlay.hidden = true;
  elements.gameScreen.classList.remove("match-complete");
  elements.modeLabel.textContent =
    session.mode === "computer"
      ? t("versusComputer", { difficulty: difficultyName(session.difficulty).toUpperCase() })
      : t("localMode");
  elements.aiDetail.textContent = "";
  refreshLegalMoves();
  clearBeams();
  render();
}

/** Synchronize the Ultra selector and explanatory progression text. */
function updateProgressUI() {
  elements.ultraDifficulty.disabled = !progress.ultraUnlocked;
  elements.ultraState.textContent = progress.ultraUnlocked ? t("ready") : t("locked");
  elements.progressNote.textContent = progress.ultraUnlocked ? t("ultraReadyNote") : t("ultraLockedNote");
  elements.progressNote.classList.toggle("unlocked", progress.ultraUnlocked);
}

/** Validate and upgrade an older active-save representation in place. */
function migrateStoredSave() {
  try {
    const data = JSON.parse(localStorage.getItem(SAVE_KEY));
    if (recoverUltraProgress(progress, data)) saveProgress(localStorage, progress);
    if (data?.version !== SAVE_VERSION) return;
    const restored = sessionFromSave(data);
    localStorage.setItem(SAVE_KEY, JSON.stringify(buildActiveSave(restored)));
  } catch {
    // Continue still reports malformed active saves when the user attempts to load one.
  }
}

/** Build the localized plain-text match log used by the copy action. */
function currentLogText() {
  const count = session.history.length;
  return [
    t("matchLogTitle"),
    matchMetadata(),
    "",
    moveCount(count),
    ...session.history.map(recordSummary),
  ].join("\n");
}

/** Copy the current localized match log or explain why copying failed. */
async function copyMatchLog() {
  if (!session.history.length) {
    showToast(t("noMovesToCopy"));
    return;
  }
  try {
    await navigator.clipboard.writeText(currentLogText());
    showToast(t("logCopied"));
  } catch {
    showToast(t("copyFailed"));
  }
}

/** Display a transient message for the standard toast duration. */
function showToast(message) {
  window.clearTimeout(toastTimer);
  elements.toast.textContent = message;
  elements.toast.classList.add("visible");
  toastTimer = window.setTimeout(() => elements.toast.classList.remove("visible"), 2600);
}

/** Apply a mirror orientation and immediately refresh its visual state. */
function selectMirror(mirror) {
  if (inputLocked) return;
  selectedMirror = mirror;
  renderMirrorSelection();
  renderBoard();
}

/** Apply, persist, and rerender the selected interface language. */
function applyLanguage(nextLanguage, persist = true) {
  language = nextLanguage === "fr" ? "fr" : "en";
  if (persist) saveLanguage(localStorage, language);
  document.documentElement.lang = language;
  document.querySelectorAll("[data-i18n]").forEach((element) => {
    element.textContent = t(element.dataset.i18n);
  });
  document.querySelectorAll("[data-i18n-aria]").forEach((element) => {
    element.setAttribute("aria-label", t(element.dataset.i18nAria));
  });
  document.querySelectorAll("[data-i18n-title]").forEach((element) => {
    element.setAttribute("title", t(element.dataset.i18nTitle));
  });
  document.querySelectorAll("[data-language]").forEach((button) => {
    const selected = button.dataset.language === language;
    button.classList.toggle("selected", selected);
    button.setAttribute("aria-pressed", String(selected));
  });
  updateProgressUI();
  if (!elements.gameScreen.hidden) {
    elements.modeLabel.textContent = session.mode === "computer"
      ? t("versusComputer", { difficulty: difficultyName(session.difficulty).toUpperCase() })
      : t("localMode");
    render();
    if (session.state.winner || session.state.draw) showResult(false);
  }
  audio.updateLabel();
}

class Audio {
  /** Initialize lazy browser-audio state without requesting playback yet. */
  constructor() {
    this.enabled = true;
    this.context = null;
  }

  /** Toggle effects and synchronize the sound control label. */
  toggle() {
    this.enabled = !this.enabled;
    elements.sound.textContent = this.enabled ? "♪" : "×";
    this.updateLabel();
  }

  /** Update localized accessible text for the sound control. */
  updateLabel() {
    const label = this.enabled ? t("muteSound") : t("enableSound");
    elements.sound.setAttribute("aria-label", label);
    elements.sound.setAttribute("title", label);
  }

  /** Synthesize and play a named lightweight interface effect. */
  play(name) {
    if (!this.enabled) return;
    try {
      this.context ||= new AudioContext();
      const oscillator = this.context.createOscillator();
      const gain = this.context.createGain();
      const settings = {
        laser: [210, 0.16],
        impact: [110, 0.12],
        victory: [520, 0.32],
        undo: [260, 0.1],
      }[name] || [440, 0.08];
      oscillator.frequency.setValueAtTime(settings[0], this.context.currentTime);
      oscillator.frequency.exponentialRampToValueAtTime(settings[0] * 1.8, this.context.currentTime + settings[1]);
      gain.gain.setValueAtTime(0.09, this.context.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, this.context.currentTime + settings[1]);
      oscillator.connect(gain).connect(this.context.destination);
      oscillator.start();
      oscillator.stop(this.context.currentTime + settings[1]);
    } catch {
      this.enabled = false;
    }
  }
}

const audio = new Audio();

for (let index = 1; index <= BOARD_SIZE; index += 1) {
  const column = document.createElement("span");
  column.textContent = String(index);
  document.querySelector("#column-labels").append(column);
  const row = document.createElement("span");
  row.textContent = String(index);
  document.querySelector("#row-labels").append(row);
}

document.querySelector("#start-computer").addEventListener("click", () => startGame("computer"));
document.querySelector("#start-local").addEventListener("click", () => startGame("local"));
elements.continueButton.addEventListener("click", continueGame);
elements.slash.addEventListener("click", () => selectMirror(Cell.SLASH));
elements.backslash.addEventListener("click", () => selectMirror(Cell.BACKSLASH));
document.querySelector("#resume").addEventListener("click", togglePause);
document.querySelector("#pause-restart").addEventListener("click", restart);
document.querySelector("#pause-menu").addEventListener("click", returnToMenu);
document.querySelector("#new-match").addEventListener("click", restart);
document.querySelector("#main-menu").addEventListener("click", returnToMenu);
document.querySelector("#play-again").addEventListener("click", restart);
document.querySelector("#result-menu").addEventListener("click", returnToMenu);
document.querySelector("#show-rules").addEventListener("click", () => elements.rules.showModal());
elements.copyLog.addEventListener("click", copyMatchLog);
elements.sound.addEventListener("click", () => audio.toggle());
document.querySelectorAll("[data-language]").forEach((button) => {
  button.addEventListener("click", () => applyLanguage(button.dataset.language));
});

document.addEventListener("keydown", (event) => {
  if (elements.rules.open) return;
  if (event.key === "Escape") togglePause();
  if (elements.gameScreen.hidden || paused) return;
  if (event.key.toLowerCase() === "q" || event.key === "/") selectMirror(Cell.SLASH);
  else if (event.key.toLowerCase() === "e" || event.key === "\\") selectMirror(Cell.BACKSLASH);
  else if (event.key.toLowerCase() === "u") undo();
  else if (event.key.toLowerCase() === "r") restart();
});

migrateStoredSave();
applyLanguage(language, false);
elements.continueButton.disabled = !hasSave();
window.__laserWar = {
  game,
  startGame,
  playMove,
  getSession: () => session,
  getLegalMoves: () => legalMoves,
};
