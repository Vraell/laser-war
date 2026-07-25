import { BOARD_SIZE, Cell, Game, cloneState } from "./engine.js";
import {
  SAVE_VERSION,
  buildActiveSave,
  createMatchId,
  legacyMatchId,
} from "./save.js";
import { loadProgress, recordResult, saveProgress } from "./progress.js";

const SAVE_KEY = "laser-war.web.v1";
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
let selectedMirror = Cell.SLASH;
let legalMoves = [];
let inputLocked = false;
let paused = false;
let lastOutcome = null;
let toastTimer = 0;
let aiWorker = null;
let aiRequestId = 0;
let aiTimer = 0;
let ultraUnlockedThisMatch = false;

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

function currentDifficulty() {
  const selected = document.querySelector('input[name="difficulty"]:checked')?.value || "medium";
  return selected === "ultra" && !progress.ultraUnlocked ? "hard" : selected;
}

function startGame(mode, difficulty = currentDifficulty(), persist = true) {
  cancelComputerTurn();
  session = createSession(mode, difficulty);
  lastOutcome = null;
  ultraUnlockedThisMatch = false;
  startGameView();
  if (persist) saveGame();
}

function playMove(move, actor) {
  if (inputLocked || paused || session.state.winner || session.state.draw) return;
  let outcome;
  try {
    outcome = game.resolveMove(session.state, move);
  } catch (error) {
    showToast(error.message);
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
  }, 720);
}

function beginComputerTurn() {
  if (elements.gameScreen.hidden || !computerTurn() || inputLocked) return;
  cancelComputerTurn();
  inputLocked = true;
  elements.status.textContent = "Computer thinking";
  elements.statusLight.style.background = "var(--cyan)";
  elements.statusLight.style.color = "var(--cyan)";
  elements.aiDetail.classList.add("thinking");
  const started = performance.now();
  const difficulty = session.difficulty;
  elements.aiDetail.textContent = difficulty === "ultra"
    ? "Ultra · mapping four-ply threats"
    : `${title(difficulty)} · analyzing legal paths`;
  renderBoard();
  aiTimer = window.setInterval(() => {
    const elapsed = (performance.now() - started) / 1000;
    elements.aiDetail.textContent = difficulty === "ultra"
      ? `Ultra · depth search · ${elapsed.toFixed(1)}s`
      : `${title(difficulty)} · analyzing · ${elapsed.toFixed(1)}s`;
  }, 250);

  const requestId = ++aiRequestId;
  aiWorker = new Worker("./ai_worker.js", { type: "module" });
  aiWorker.addEventListener("message", ({ data }) => {
    if (data.requestId !== requestId || requestId !== aiRequestId) return;
    finishComputerTurn(data.result);
  });
  aiWorker.addEventListener("error", () => {
    if (requestId !== aiRequestId) return;
    cancelComputerTurn();
    inputLocked = false;
    render();
    showToast("Computer search failed. Start a new match to continue.");
  });
  aiWorker.postMessage({ requestId, state: cloneState(session.state), difficulty });
}

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
  elements.aiDetail.textContent =
    `AI · depth ${result.depth} · ${result.nodes.toLocaleString()} positions · ${formatElapsed(result.elapsed)}`;
  playMove(result.move, "Computer");
}

function cancelComputerTurn(invalidate = true) {
  if (invalidate) aiRequestId += 1;
  window.clearInterval(aiTimer);
  aiTimer = 0;
  aiWorker?.terminate();
  aiWorker = null;
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

function render() {
  renderMirrorSelection();
  renderBoard();
  renderStatus();
  renderLog();
}

function renderMirrorSelection() {
  elements.slash.classList.toggle("selected", selectedMirror === Cell.SLASH);
  elements.backslash.classList.toggle("selected", selectedMirror === Cell.BACKSLASH);
}

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
      cell.className = "cell";
      cell.dataset.row = String(row);
      cell.dataset.col = String(col);
      cell.setAttribute("role", "gridcell");
      cell.setAttribute("aria-label", cellLabel(row, col, value, moveIsLegal));
      if (forbidden.has(`${row},${col}`)) cell.classList.add("blocked");
      if (moveIsLegal && humanTurn() && !inputLocked && !paused) cell.classList.add("legal");
      cell.disabled = !moveIsLegal || !humanTurn() || inputLocked || paused;
      cell.addEventListener("click", () => playMove(move, session.mode === "computer" ? "You" : title(session.state.turn)));
      cell.addEventListener("mouseenter", () => {
        if (!cell.disabled) {
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

function cellLabel(row, col, value, moveIsLegal) {
  const names = {
    [Cell.EMPTY]: "empty",
    [Cell.SLASH]: "slash mirror",
    [Cell.BACKSLASH]: "backslash mirror",
    [Cell.SHIELD]: "shield",
    [Cell.TOP_KING]: "top king",
    [Cell.BOTTOM_KING]: "bottom king",
  };
  const action = moveIsLegal ? `, place ${selectedMirror === Cell.SLASH ? "slash" : "backslash"} mirror` : "";
  return `Row ${row + 1}, column ${col + 1}, ${names[value]}${action}`;
}

function renderStatus() {
  let text = "";
  let color = "var(--amber)";
  if (session.state.winner) {
    text = `${title(session.state.winner)} wins`;
    color = session.state.winner === "bottom" ? "var(--amber)" : "var(--cyan)";
  } else if (session.state.draw) {
    text = "Draw";
    color = "var(--muted)";
  } else if (inputLocked && computerTurn()) {
    text = "Computer thinking";
    color = "var(--cyan)";
  } else if (session.mode === "computer") {
    text = session.state.turn === "bottom" ? "Your turn" : "Computer turn";
    color = session.state.turn === "bottom" ? "var(--amber)" : "var(--cyan)";
  } else {
    text = `${title(session.state.turn)} to move`;
    color = session.state.turn === "bottom" ? "var(--amber)" : "var(--cyan)";
  }
  elements.status.textContent = text;
  elements.statusLight.style.background = color;
  elements.statusLight.style.color = color;
}

function renderLog() {
  elements.moveCount.textContent = `${session.history.length} ${session.history.length === 1 ? "move" : "moves"}`;
  elements.copyLog.disabled = session.history.length === 0;
  elements.log.replaceChildren();
  if (!session.history.length) {
    const empty = document.createElement("li");
    empty.className = "empty-log";
    empty.textContent = "Awaiting the first move.";
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

function recordSummary(record) {
  const effects = [];
  if (record.outcome.destroyed.length) {
    effects.push(`shield at ${record.outcome.destroyed.map(([row, col]) => `R${row + 1}C${col + 1}`).join(", ")}`);
  }
  if (record.outcome.hitKings.size) effects.push(`${[...record.outcome.hitKings].sort().join(" and ")} king hit`);
  return `${record.actor}: ${record.move.mirror} at R${record.move.row + 1}C${record.move.col + 1} · ${effects.join(", ") || "no damage"}`;
}

function renderBeams(beams) {
  clearBeams();
  beams.forEach((beam, index) => {
    const points = [[index === 0 ? 0 : 900, 450]];
    points.push(...beam.path.map(([row, col]) => [col * 100 + 50, row * 100 + 50]));
    const pointString = points.map((point) => point.join(",")).join(" ");
    const color = index === 0 ? "var(--red)" : "var(--cyan)";
    for (const className of ["beam-glow", "beam-core"]) {
      const line = document.createElementNS("http://www.w3.org/2000/svg", "polyline");
      line.setAttribute("points", pointString);
      line.setAttribute("class", className);
      if (className === "beam-core") line.style.stroke = color;
      elements.beams.append(line);
    }
  });
}

function clearBeams() {
  elements.beams.replaceChildren();
}

function showResult() {
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
  if (session.state.draw) {
    elements.resultTitle.textContent = "DRAW";
    elements.resultTitle.style.color = "var(--ink)";
    elements.resultDetail.textContent = `${session.history.length} moves · neither king survives`;
  } else if (session.mode === "computer") {
    const victory = session.state.winner === "bottom";
    elements.resultTitle.textContent = victory ? "VICTORY" : "DEFEAT";
    elements.resultTitle.style.color = victory ? "var(--amber)" : "var(--cyan)";
    elements.resultDetail.textContent = ultraUnlockedThisMatch
      ? "Ultra difficulty unlocked"
      : `${title(session.difficulty)} · ${session.history.length} moves`;
  } else {
    elements.resultTitle.textContent = `${session.state.winner.toUpperCase()} WINS`;
    elements.resultTitle.style.color = session.state.winner === "bottom" ? "var(--amber)" : "var(--cyan)";
    elements.resultDetail.textContent = `${session.history.length} moves`;
  }
  audio.play("victory");
}

function undo() {
  if (inputLocked || !session.history.length) return;
  cancelComputerTurn();
  const record = session.history.pop();
  session.redo.push(record);
  session.state = cloneState(record.before);
  lastOutcome = null;
  elements.resultOverlay.hidden = true;
  clearBeams();
  refreshLegalMoves();
  render();
  saveGame();
  audio.play("undo");
}

function redo() {
  if (inputLocked || !session.redo.length) return;
  cancelComputerTurn();
  const old = session.redo.pop();
  let outcome;
  try {
    outcome = game.resolveMove(session.state, old.move);
  } catch {
    showToast("That move can no longer be redone.");
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
    window.setTimeout(clearBeams, 720);
  }
}

function restart() {
  startGame(session.mode, session.difficulty);
}

function returnToMenu() {
  cancelComputerTurn();
  inputLocked = false;
  paused = false;
  elements.pauseOverlay.hidden = true;
  elements.resultOverlay.hidden = true;
  elements.gameScreen.hidden = true;
  elements.menu.hidden = false;
  elements.continueButton.disabled = !hasSave();
}

function togglePause() {
  if (elements.gameScreen.hidden || inputLocked || session.state.winner || session.state.draw) return;
  paused = !paused;
  elements.pauseOverlay.hidden = !paused;
  renderBoard();
}

function saveGame() {
  try {
    localStorage.setItem(SAVE_KEY, JSON.stringify(buildActiveSave(session)));
    elements.continueButton.disabled = false;
  } catch {
    showToast("Match storage is full or unavailable.");
  }
}

function hasSave() {
  try {
    return [1, SAVE_VERSION].includes(JSON.parse(localStorage.getItem(SAVE_KEY))?.version);
  } catch {
    return false;
  }
}

function sessionFromSave(data) {
  if (![1, SAVE_VERSION].includes(data?.version)) throw new Error("Unsupported save.");
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
    showToast(`Could not load save: ${error.message}`);
    return;
  }
  if (session.state.winner || session.state.draw) {
    if (lastOutcome) renderBeams(lastOutcome.beams);
    showResult();
  } else if (computerTurn()) {
    beginComputerTurn();
  }
}

function startGameView() {
  selectedMirror = Cell.SLASH;
  inputLocked = false;
  paused = false;
  elements.menu.hidden = true;
  elements.gameScreen.hidden = false;
  elements.pauseOverlay.hidden = true;
  elements.resultOverlay.hidden = true;
  elements.modeLabel.textContent =
    session.mode === "computer" ? `VS COMPUTER · ${session.difficulty.toUpperCase()}` : "LOCAL TWO PLAYER";
  elements.aiDetail.textContent = "";
  refreshLegalMoves();
  clearBeams();
  render();
}

function updateProgressUI() {
  elements.ultraDifficulty.disabled = !progress.ultraUnlocked;
  elements.ultraState.textContent = progress.ultraUnlocked ? "READY" : "LOCKED";
  elements.progressNote.textContent = progress.ultraUnlocked
    ? "Ultra is ready. Expect a longer, deeper search."
    : "Defeat Hard to unlock Ultra.";
  elements.progressNote.classList.toggle("unlocked", progress.ultraUnlocked);
}

function migrateStoredSave() {
  try {
    const data = JSON.parse(localStorage.getItem(SAVE_KEY));
    if (![1, SAVE_VERSION].includes(data?.version)) return;
    const restored = sessionFromSave(data);
    localStorage.setItem(SAVE_KEY, JSON.stringify(buildActiveSave(restored)));
  } catch {
    // Continue still reports malformed active saves when the user attempts to load one.
  }
}

function currentLogText() {
  const count = session.history.length;
  return [
    "MATCH LOG",
    "",
    `${count} ${count === 1 ? "move" : "moves"}`,
    ...session.history.map(recordSummary),
  ].join("\n");
}

async function copyMatchLog() {
  if (!session.history.length) {
    showToast("No moves to copy yet.");
    return;
  }
  try {
    await navigator.clipboard.writeText(currentLogText());
    showToast("Match log copied.");
  } catch {
    showToast("Could not copy the match log.");
  }
}

function showToast(message) {
  window.clearTimeout(toastTimer);
  elements.toast.textContent = message;
  elements.toast.classList.add("visible");
  toastTimer = window.setTimeout(() => elements.toast.classList.remove("visible"), 2600);
}

function selectMirror(mirror) {
  if (inputLocked) return;
  selectedMirror = mirror;
  renderMirrorSelection();
  renderBoard();
}

function title(value) {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

class Audio {
  constructor() {
    this.enabled = true;
    this.context = null;
  }

  toggle() {
    this.enabled = !this.enabled;
    elements.sound.textContent = this.enabled ? "♪" : "×";
    elements.sound.setAttribute("aria-label", this.enabled ? "Mute sound" : "Enable sound");
  }

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
updateProgressUI();
elements.continueButton.disabled = !hasSave();
window.__laserWar = {
  game,
  startGame,
  playMove,
  getSession: () => session,
  getLegalMoves: () => legalMoves,
};
