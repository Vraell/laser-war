import { BOARD_SIZE, MIDDLE_ROW, Cell, Game, cloneState } from "./engine.js?v=0.13.3";
import {
  SAVE_VERSION,
  buildActiveSave,
  createMatchId,
  legacyMatchId,
} from "./save.js?v=0.13.3";
import {
  loadProgress,
  recordResult,
  recoverUltraProgress,
  saveProgress,
} from "./progress.js?v=0.13.3";
import { loadLanguage, saveLanguage, translate } from "./i18n.js?v=0.13.3";
import { beamPoints } from "./beam.js?v=0.13.3";
import { drawDetailKey } from "./result.js?v=0.13.3";
import {
  BLUE_SIDE,
  RED_SIDE,
  displayPoint,
  logicalSquare,
  opposingSide,
  perspectiveLabels,
} from "./perspective.js?v=0.13.3";

const SAVE_KEY = "laser-war.web.v1";
const SOUND_KEY = "laser-war.sound.v1";
const GAME_VERSION = "v0.13.3";
const BEAM_VISIBLE_MS = 1_300;
const ULTRA_WATCHDOG_MS = 11_000;
const game = new Game();

const elements = {
  menu: document.querySelector("#menu-screen"),
  gameScreen: document.querySelector("#game-screen"),
  board: document.querySelector("#board"),
  beams: document.querySelector("#beams"),
  status: document.querySelector("#status"),
  statusLight: document.querySelector("#status-light"),
  statusBlock: document.querySelector(".status-block"),
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
  soundButtons: [...document.querySelectorAll("[data-sound-toggle]")],
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
let aiWatchdog = 0;
let aiProgress = null;
let aiFallbackResult = null;
let aiStartedAt = 0;
let aiDifficulty = "medium";
let ultraUnlockedThisMatch = false;
let pendingShieldImpacts = new Set();

function t(key, values = {}) {
  return translate(language, key, values);
}

function difficultyName(difficulty) {
  return t(difficulty);
}

function sideName(side) {
  return t(side);
}

function sideColor(side) {
  return side === RED_SIDE ? "var(--player-red)" : "var(--player-blue)";
}

function canHumanAct() {
  return humanTurn()
    && !inputLocked
    && !paused
    && !session.state.winner
    && !session.state.draw;
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
    return t("computerMatchup", {
      difficulty: difficultyName(session.difficulty),
      human: sideName(session.humanSide),
      computer: sideName(opposingSide(session.humanSide)),
    });
  }
  return t("localMatchup");
}

/** Build the localized date and participant line shared by the UI and clipboard. */
function matchMetadata() {
  return `${matchDate()} · ${matchupLabel()} · ${session.gameVersion}`;
}

/** Create an empty browser match session with stable identity metadata. */
function createSession(
  mode = "computer",
  difficulty = "medium",
  id = createMatchId(),
  startedAt = new Date().toISOString(),
  gameVersion = GAME_VERSION,
  humanSide = RED_SIDE,
) {
  return {
    id,
    startedAt,
    gameVersion,
    mode,
    difficulty,
    humanSide,
    state: game.initialState(),
    history: [],
  };
}

function moveKey(move) {
  return `${move.row},${move.col},${move.mirror}`;
}

function humanTurn() {
  return session.mode === "local" || session.state.turn === session.humanSide;
}

function computerTurn() {
  return session.mode === "computer"
    && session.state.turn === opposingSide(session.humanSide)
    && !session.state.winner
    && !session.state.draw;
}

/** Read the selected difficulty while enforcing the Ultra lock. */
function currentDifficulty() {
  const selected = document.querySelector('input[name="difficulty"]:checked')?.value || "medium";
  return selected === "ultra" && !progress.ultraUnlocked ? "hard" : selected;
}

/** Read the side selected for a new single-player match. */
function currentHumanSide() {
  return document.querySelector('input[name="player-side"]:checked')?.value === BLUE_SIDE
    ? BLUE_SIDE
    : RED_SIDE;
}

/** Replace the active session with a fresh match and optionally persist it. */
function startGame(
  mode,
  difficulty = currentDifficulty(),
  persist = true,
  humanSide = mode === "computer" ? currentHumanSide() : RED_SIDE,
) {
  cancelComputerTurn();
  session = createSession(
    mode,
    difficulty,
    createMatchId(),
    new Date().toISOString(),
    GAME_VERSION,
    humanSide,
  );
  lastOutcome = null;
  ultraUnlockedThisMatch = false;
  pendingShieldImpacts = new Set();
  startGameView();
  if (persist) saveGame();
  if (computerTurn()) beginComputerTurn();
}

/** Resolve, record, animate, and save one player or computer move. */
function playMove(move, actor) {
  if (inputLocked || paused || session.state.winner || session.state.draw) return;
  let outcome;
  try {
    outcome = game.resolveMove(session.state, move);
  } catch (error) {
    audio.play("illegal");
    showToast(t("illegalMove"), "warning");
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
  lastOutcome = outcome;
  pendingShieldImpacts = new Set(
    outcome.destroyed.map(([row, col]) => `${row},${col}`),
  );
  inputLocked = true;
  refreshLegalMoves();
  render();
  renderBeams(outcome.beams);
  audio.play(outcome.destroyed.length ? "impact" : "laser");
  saveGame();
  const matchId = session.id;

  window.setTimeout(() => {
    if (session.id !== matchId || elements.gameScreen.hidden) return;
    pendingShieldImpacts = new Set();
    inputLocked = false;
    render();
    if (session.state.winner || session.state.draw) {
      showResult();
    } else {
      clearBeams();
      if (computerTurn()) beginComputerTurn();
      else audio.play("turn");
    }
  }, BEAM_VISIBLE_MS);
}

/** Lock input and submit the current position to the AI worker. */
function beginComputerTurn() {
  if (elements.gameScreen.hidden || !computerTurn() || inputLocked) return;
  cancelComputerTurn(true, false);
  inputLocked = true;
  elements.status.textContent = t("computerThinking");
  elements.statusLight.style.background = sideColor(opposingSide(session.humanSide));
  elements.statusLight.style.color = sideColor(opposingSide(session.humanSide));
  elements.aiDetail.classList.add("thinking");
  const started = performance.now();
  const difficulty = session.difficulty;
  aiStartedAt = started;
  aiDifficulty = difficulty;
  aiProgress = difficulty === "ultra" ? { phase: "preparing", depth: 0, nodes: 0 } : null;
  aiFallbackResult = null;
  renderAiProgress(difficulty, started);
  renderBoard();
  aiTimer = window.setInterval(() => {
    renderAiProgress(difficulty, started);
  }, 250);

  const requestId = ++aiRequestId;
  if (!aiWorker) {
    aiWorker = new Worker("./ai_worker.js?v=0.13.3", { type: "module" });
    aiWorker.addEventListener("message", ({ data }) => {
      if (data.requestId !== aiRequestId) return;
      if (data.type === "progress") {
        aiProgress = data.progress;
        if (data.progress.best?.move) aiFallbackResult = data.progress.best;
        renderAiProgress(aiDifficulty, aiStartedAt);
        return;
      }
      finishComputerTurn(data.result);
    });
    aiWorker.addEventListener("error", () => {
      cancelComputerTurn();
      inputLocked = false;
      render();
      showToast(t("computerSearchFailed"), "warning");
    });
  }
  aiWorker.postMessage({ requestId, state: cloneState(session.state), difficulty });
  if (difficulty === "ultra") {
    aiWatchdog = window.setTimeout(
      () => finishTimedOutComputerTurn(requestId),
      ULTRA_WATCHDOG_MS,
    );
  }
}

/** Terminate an overrun worker and play its last fully validated result. */
function finishTimedOutComputerTurn(requestId) {
  if (requestId !== aiRequestId || !computerTurn() || !inputLocked) return;
  const fallback = aiFallbackResult;
  const elapsed = performance.now() - aiStartedAt;
  cancelComputerTurn(true, true);
  inputLocked = false;
  if (!fallback?.move) {
    render();
    showToast(t("computerSearchFailed"), "warning");
    return;
  }
  finishComputerTurn({ ...fallback, elapsed });
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
  cancelComputerTurn(false, false);
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
function cancelComputerTurn(invalidate = true, terminateWorker = true) {
  if (invalidate) aiRequestId += 1;
  window.clearInterval(aiTimer);
  aiTimer = 0;
  window.clearTimeout(aiWatchdog);
  aiWatchdog = 0;
  if (terminateWorker) {
    aiWorker?.terminate();
    aiWorker = null;
  }
  aiProgress = null;
  aiFallbackResult = null;
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
  const slashSelected = selectedMirror === Cell.SLASH;
  elements.slash.classList.toggle("selected", slashSelected);
  elements.backslash.classList.toggle("selected", !slashSelected);
  elements.slash.setAttribute("aria-pressed", String(slashSelected));
  elements.backslash.setAttribute("aria-pressed", String(!slashSelected));
  elements.slash.disabled = !canHumanAct();
  elements.backslash.disabled = !canHumanAct();
}

/** Render numeric coordinates in the player's fixed board perspective. */
function renderBoardLabels() {
  const labels = perspectiveLabels(session.humanSide, BOARD_SIZE);
  const columns = document.querySelector("#column-labels");
  const rows = document.querySelector("#row-labels");
  columns.replaceChildren(...labels.map((label) => {
    const element = document.createElement("span");
    element.textContent = String(label);
    return element;
  }));
  rows.replaceChildren(...labels.map((label) => {
    const element = document.createElement("span");
    element.textContent = String(label);
    return element;
  }));
}

/** Render all board cells with legal, explanatory, and terminal input states. */
function renderBoard() {
  const legal = new Set(legalMoves.map(moveKey));
  const forbidden = game.mirrorForbiddenSquares(session.state.board);
  const latestMove = session.history.at(-1)?.move;
  const mirrorOwners = new Map(
    session.history.map((record) => [
      `${record.move.row},${record.move.col}`,
      record.before.turn === RED_SIDE ? "red" : "blue",
    ]),
  );
  elements.board.replaceChildren();

  for (let displayRow = 0; displayRow < BOARD_SIZE; displayRow += 1) {
    for (let displayCol = 0; displayCol < BOARD_SIZE; displayCol += 1) {
      const [row, col] = logicalSquare(
        displayRow,
        displayCol,
        session.humanSide,
        BOARD_SIZE,
      );
      const cell = document.createElement("button");
      const value = pendingShieldImpacts.has(`${row},${col}`)
        ? Cell.SHIELD
        : session.state.board[row][col];
      const move = { row, col, mirror: selectedMirror };
      const moveIsLegal = legal.has(moveKey(move));
      const canAct = canHumanAct();
      const explainable = canAct && !moveIsLegal;
      cell.className = "cell";
      cell.dataset.row = String(row);
      cell.dataset.col = String(col);
      cell.setAttribute("role", "gridcell");
      cell.setAttribute("aria-label", cellLabel(row, col, value, moveIsLegal, explainable));
      if (forbidden.has(`${row},${col}`)) cell.classList.add("blocked");
      if (latestMove?.row === row && latestMove?.col === col) cell.classList.add("last-move");
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
      if (value !== Cell.EMPTY) {
        cell.append(pieceFor(value, row, mirrorOwners.get(`${row},${col}`)));
      }
      elements.board.append(cell);
    }
  }
}

/** Build the visual token for one nonempty engine cell. */
function pieceFor(value, row, mirrorOwner = null) {
  const piece = document.createElement("span");
  piece.className = "piece";
  if (value === Cell.SLASH || value === Cell.BACKSLASH) {
    piece.classList.add("mirror");
    if (mirrorOwner) piece.classList.add(`${mirrorOwner}-piece`);
    piece.style.setProperty("--mirror-angle", value === Cell.SLASH ? "45deg" : "-45deg");
  } else if (value === Cell.SHIELD) {
    piece.classList.add("shield", row < MIDDLE_ROW ? "blue-piece" : "red-piece");
  } else {
    piece.classList.add(
      "king",
      value === Cell.TOP_KING ? "blue-piece" : "red-piece",
    );
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
  audio.play("illegal");
  showToast(t(reason), "warning");
}

/** Render the current turn, search, or terminal status. */
function renderStatus() {
  let text = "";
  let color = "var(--player-red)";
  if (session.state.winner) {
    text = t("sideWins", { side: t(session.state.winner) });
    color = sideColor(session.state.winner);
  } else if (session.state.draw) {
    text = t("draw");
    color = "var(--muted)";
  } else if (inputLocked && computerTurn()) {
    text = t("computerThinking");
    color = sideColor(opposingSide(session.humanSide));
  } else if (session.mode === "computer") {
    text = humanTurn() ? t("yourTurn") : t("computerTurn");
    color = sideColor(session.state.turn);
  } else {
    text = t("sideToMove", { side: t(session.state.turn) });
    color = sideColor(session.state.turn);
  }
  elements.status.textContent = text;
  elements.statusLight.style.background = color;
  elements.statusLight.style.color = color;
  elements.statusBlock.style.setProperty("--status-color", color);
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
    const points = beamPoints(beam, index).map(
      (point) => displayPoint(point, session.humanSide),
    );
    const pointString = points.map((point) => point.join(",")).join(" ");
    const color = "var(--laser)";
    for (const className of ["beam-glow", "beam-core", "beam-flow"]) {
      const line = document.createElementNS("http://www.w3.org/2000/svg", "polyline");
      line.setAttribute("points", pointString);
      line.setAttribute("pathLength", "1");
      line.setAttribute("class", className);
      if (className === "beam-core") line.style.stroke = color;
      elements.beams.append(line);
    }
    if (beam.hitShield) {
      const [row, col] = beam.hitShield;
      const [impactX, impactY] = displayPoint(
        [col * 100 + 50, row * 100 + 50],
        session.humanSide,
      );
      const impact = document.createElementNS("http://www.w3.org/2000/svg", "circle");
      impact.setAttribute("cx", String(impactX));
      impact.setAttribute("cy", String(impactY));
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
      humanSide: session.humanSide,
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
    const victory = session.state.winner === session.humanSide;
    elements.resultTitle.textContent = victory ? t("victory") : t("defeat");
    elements.resultTitle.style.color = sideColor(session.state.winner);
    elements.resultDetail.textContent = ultraUnlockedThisMatch
      ? t("ultraUnlocked")
      : t("resultDetail", {
        difficulty: difficultyName(session.difficulty),
        count: moveCount(session.history.length),
      });
  } else {
    elements.resultTitle.textContent = t("sideWins", { side: t(session.state.winner) }).toUpperCase();
    elements.resultTitle.style.color = sideColor(session.state.winner);
    elements.resultDetail.textContent = moveCount(session.history.length);
  }
  if (!playSound) return;
  if (session.state.draw) audio.play("draw");
  else if (session.mode === "computer" && session.state.winner !== session.humanSide) {
    audio.play("defeat");
  } else {
    audio.play("victory");
  }
}

function restart() {
  startGame(session.mode, session.difficulty, true, session.humanSide);
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
    showToast(t("storageFailed"), "warning");
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
    data.gameVersion || GAME_VERSION,
    data.humanSide === BLUE_SIDE ? BLUE_SIDE : RED_SIDE,
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
    showToast(t("loadFailed", { error: error.message }), "warning");
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
  document.querySelector(
    `input[name="player-side"][value="${session.humanSide}"]`,
  ).checked = true;
  renderBoardLabels();
  renderModeLabel();
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

/** Render the localized mode, difficulty, and human side in the top bar. */
function renderModeLabel() {
  elements.modeLabel.textContent = session.mode === "computer"
    ? t("versusComputerSide", {
      difficulty: difficultyName(session.difficulty).toUpperCase(),
      side: sideName(session.humanSide).toUpperCase(),
    })
    : t("localMode");
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
    audio.play("illegal");
    showToast(t("noMovesToCopy"), "warning");
    return;
  }
  try {
    await navigator.clipboard.writeText(currentLogText());
    audio.play("copy");
    showToast(t("logCopied"), "success");
  } catch {
    audio.play("illegal");
    showToast(t("copyFailed"), "warning");
  }
}

/** Display a transient message for the standard toast duration. */
function showToast(message, tone = "info") {
  window.clearTimeout(toastTimer);
  elements.toast.textContent = message;
  elements.toast.dataset.tone = tone;
  elements.toast.classList.add("visible");
  toastTimer = window.setTimeout(() => elements.toast.classList.remove("visible"), 2600);
}

/** Apply a mirror orientation and immediately refresh its visual state. */
function selectMirror(mirror) {
  if (inputLocked) return;
  if (selectedMirror !== mirror) audio.play("select");
  selectedMirror = mirror;
  renderMirrorSelection();
  renderBoard();
}

/** Apply, persist, and rerender the selected interface language. */
function applyLanguage(nextLanguage, persist = true) {
  const normalized = nextLanguage === "fr" ? "fr" : "en";
  if (persist && normalized !== language) audio.play("select");
  language = normalized;
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
    renderModeLabel();
    render();
    if (session.state.winner || session.state.draw) showResult(false);
  }
  audio.updateLabel();
}

class SoundEffects {
  /** Initialize lazy browser-audio state without requesting playback yet. */
  constructor() {
    try {
      this.enabled = localStorage.getItem(SOUND_KEY) !== "off";
    } catch {
      this.enabled = true;
    }
    this.context = null;
  }

  /** Toggle effects and synchronize the sound control label. */
  toggle() {
    if (this.enabled) this.play("toggle");
    this.enabled = !this.enabled;
    try {
      localStorage.setItem(SOUND_KEY, this.enabled ? "on" : "off");
    } catch {
      // Sound still works for this session when storage is unavailable.
    }
    this.updateLabel();
    if (this.enabled) this.play("toggle");
  }

  /** Update localized accessible text for the sound control. */
  updateLabel() {
    const label = this.enabled ? t("muteSound") : t("enableSound");
    for (const button of elements.soundButtons) {
      button.dataset.muted = String(!this.enabled);
      button.setAttribute("aria-label", label);
      button.setAttribute("title", label);
      button.setAttribute("aria-pressed", String(this.enabled));
    }
  }

  /** Create one short oscillator voice within a named interface cue. */
  tone({ from, to = from, duration, delay = 0, gain = 0.08, type = "sine" }) {
    const startsAt = this.context.currentTime + delay;
    const oscillator = this.context.createOscillator();
    const envelope = this.context.createGain();
    oscillator.type = type;
    oscillator.frequency.setValueAtTime(from, startsAt);
    oscillator.frequency.exponentialRampToValueAtTime(to, startsAt + duration);
    envelope.gain.setValueAtTime(Math.max(0.001, gain), startsAt);
    envelope.gain.exponentialRampToValueAtTime(0.001, startsAt + duration);
    oscillator.connect(envelope).connect(this.context.destination);
    oscillator.start(startsAt);
    oscillator.stop(startsAt + duration);
  }

  /** Synthesize one compact cue from a consistent electronic sound palette. */
  play(name) {
    if (!this.enabled) return;
    const cues = {
      toggle: [
        { from: 420, to: 620, duration: 0.06, gain: 0.055, type: "triangle" },
      ],
      select: [
        { from: 540, to: 760, duration: 0.055, gain: 0.06, type: "triangle" },
        { from: 980, to: 760, duration: 0.035, gain: 0.025, type: "sine" },
      ],
      confirm: [
        { from: 330, to: 430, duration: 0.07, gain: 0.065, type: "triangle" },
        { from: 520, to: 680, duration: 0.08, delay: 0.045, gain: 0.055, type: "triangle" },
      ],
      panel: [
        { from: 260, to: 390, duration: 0.08, gain: 0.045, type: "sine" },
      ],
      laser: [
        { from: 210, to: 378, duration: 0.16, gain: 0.234, type: "sine" },
      ],
      impact: [
        { from: 150, to: 820, duration: 0.18, gain: 0.09, type: "sawtooth" },
        { from: 105, to: 48, duration: 0.2, delay: 0.12, gain: 0.15, type: "triangle" },
        { from: 1250, to: 260, duration: 0.12, delay: 0.11, gain: 0.055, type: "square" },
      ],
      illegal: [
        { from: 170, to: 115, duration: 0.12, gain: 0.065, type: "square" },
        { from: 135, to: 105, duration: 0.1, delay: 0.07, gain: 0.045, type: "square" },
      ],
      turn: [
        { from: 500, to: 660, duration: 0.08, gain: 0.045, type: "sine" },
      ],
      copy: [
        { from: 650, to: 820, duration: 0.07, gain: 0.045, type: "triangle" },
        { from: 820, to: 1040, duration: 0.09, delay: 0.055, gain: 0.04, type: "triangle" },
      ],
      victory: [
        { from: 392, duration: 0.16, gain: 0.07, type: "triangle" },
        { from: 523, duration: 0.18, delay: 0.1, gain: 0.07, type: "triangle" },
        { from: 659, to: 784, duration: 0.28, delay: 0.2, gain: 0.075, type: "triangle" },
      ],
      defeat: [
        { from: 440, to: 390, duration: 0.16, gain: 0.065, type: "triangle" },
        { from: 330, to: 280, duration: 0.18, delay: 0.11, gain: 0.065, type: "triangle" },
        { from: 220, to: 165, duration: 0.24, delay: 0.22, gain: 0.07, type: "triangle" },
      ],
      draw: [
        { from: 330, to: 392, duration: 0.18, gain: 0.06, type: "sine" },
        { from: 392, to: 330, duration: 0.2, delay: 0.14, gain: 0.055, type: "sine" },
      ],
    };
    try {
      const AudioContextClass = globalThis.AudioContext || globalThis.webkitAudioContext;
      if (!AudioContextClass) return;
      this.context ||= new AudioContextClass();
      if (this.context.state === "suspended") this.context.resume();
      for (const voice of cues[name] || cues.select) this.tone(voice);
    } catch {
      // Audio failure must never interrupt the game.
    }
  }
}

const audio = new SoundEffects();

document.querySelector("#start-computer").addEventListener("click", () => {
  audio.play("confirm");
  startGame("computer");
});
document.querySelector("#start-local").addEventListener("click", () => {
  audio.play("confirm");
  startGame("local");
});
elements.continueButton.addEventListener("click", () => {
  audio.play("confirm");
  continueGame();
});
elements.slash.addEventListener("click", () => selectMirror(Cell.SLASH));
elements.backslash.addEventListener("click", () => selectMirror(Cell.BACKSLASH));
document.querySelector("#resume").addEventListener("click", () => {
  audio.play("panel");
  togglePause();
});
document.querySelector("#pause-restart").addEventListener("click", () => {
  audio.play("confirm");
  restart();
});
document.querySelector("#pause-menu").addEventListener("click", () => {
  audio.play("panel");
  returnToMenu();
});
document.querySelector("#new-match").addEventListener("click", () => {
  audio.play("confirm");
  restart();
});
document.querySelector("#main-menu").addEventListener("click", () => {
  audio.play("panel");
  returnToMenu();
});
document.querySelector("#play-again").addEventListener("click", () => {
  audio.play("confirm");
  restart();
});
document.querySelector("#result-menu").addEventListener("click", () => {
  audio.play("panel");
  returnToMenu();
});
document.querySelector("#show-rules").addEventListener("click", () => {
  audio.play("panel");
  elements.rules.showModal();
});
elements.copyLog.addEventListener("click", copyMatchLog);
elements.soundButtons.forEach((button) => {
  button.addEventListener("click", () => audio.toggle());
});
document.querySelectorAll("[data-language]").forEach((button) => {
  button.addEventListener("click", () => applyLanguage(button.dataset.language));
});
document.querySelectorAll('input[name="difficulty"], input[name="player-side"]').forEach((input) => {
  input.addEventListener("change", () => audio.play("select"));
});
elements.rules.addEventListener("close", () => audio.play("panel"));

document.addEventListener("keydown", (event) => {
  if (elements.rules.open) return;
  if (event.key === "Escape") togglePause();
  if (elements.gameScreen.hidden || paused) return;
  if (event.key.toLowerCase() === "q" || event.key === "/") selectMirror(Cell.SLASH);
  else if (event.key.toLowerCase() === "e" || event.key === "\\") selectMirror(Cell.BACKSLASH);
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
