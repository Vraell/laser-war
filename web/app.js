import { BOARD_SIZE, Cell, Game, chooseComputerMove, cloneState } from "./engine.js";
import {
  SAVE_VERSION,
  buildActiveSave,
  buildMatchRecord,
  createMatchId,
  legacyMatchId,
  loadMatchArchive,
  upsertMatchRecord,
} from "./archive.js";

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
  exportLogs: document.querySelector("#export-logs"),
  slash: document.querySelector("#select-slash"),
  backslash: document.querySelector("#select-backslash"),
  pauseOverlay: document.querySelector("#pause-overlay"),
  resultOverlay: document.querySelector("#result-overlay"),
  resultTitle: document.querySelector("#result-title"),
  toast: document.querySelector("#toast"),
  rules: document.querySelector("#rules-dialog"),
  sound: document.querySelector("#sound-toggle"),
};

let session = createSession();
let selectedMirror = Cell.SLASH;
let legalMoves = [];
let inputLocked = false;
let paused = false;
let lastOutcome = null;
let toastTimer = 0;

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
    events: [],
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
  return document.querySelector('input[name="difficulty"]:checked').value;
}

function startGame(mode, difficulty = currentDifficulty(), persist = true) {
  session = createSession(mode, difficulty);
  lastOutcome = null;
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
  session.events.push(eventForRecord(record));
  lastOutcome = outcome;
  inputLocked = true;
  refreshLegalMoves();
  render();
  renderBeams(outcome.beams);
  audio.play(outcome.destroyed.length ? "impact" : "laser");
  saveGame();

  window.setTimeout(() => {
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
  if (!computerTurn() || inputLocked) return;
  inputLocked = true;
  elements.status.textContent = "Computer thinking";
  elements.statusLight.style.background = "var(--cyan)";
  elements.aiDetail.textContent = "Analyzing legal paths…";
  renderBoard();

  window.setTimeout(() => {
    const result = chooseComputerMove(game, session.state, session.difficulty);
    inputLocked = false;
    if (!result.move) {
      session.state.draw = true;
      saveGame();
      render();
      showResult();
      return;
    }
    elements.aiDetail.textContent =
      `AI · ${result.nodes.toLocaleString()} positions · ${Math.round(result.elapsed)} ms`;
    playMove(result.move, "Computer");
  }, 80);
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
}

function renderLog() {
  elements.moveCount.textContent = `${session.history.length} ${session.history.length === 1 ? "move" : "moves"}`;
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

function eventForRecord(record, type = "move") {
  return {
    type,
    at: new Date().toISOString(),
    number: record.number,
    actor: record.actor,
    row: record.move.row,
    col: record.move.col,
    mirror: record.move.mirror,
    destroyed: record.outcome.destroyed.map(([row, col]) => [row, col]),
    hitKings: [...record.outcome.hitKings].sort(),
  };
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
  elements.resultOverlay.hidden = false;
  if (session.state.draw) {
    elements.resultTitle.textContent = "DRAW";
    elements.resultTitle.style.color = "var(--ink)";
  } else if (session.mode === "computer") {
    const victory = session.state.winner === "bottom";
    elements.resultTitle.textContent = victory ? "VICTORY" : "DEFEAT";
    elements.resultTitle.style.color = victory ? "var(--amber)" : "var(--cyan)";
  } else {
    elements.resultTitle.textContent = `${session.state.winner.toUpperCase()} WINS`;
    elements.resultTitle.style.color = session.state.winner === "bottom" ? "var(--amber)" : "var(--cyan)";
  }
  audio.play("victory");
}

function undo() {
  if (inputLocked || !session.history.length) return;
  const record = session.history.pop();
  session.redo.push(record);
  session.events.push({ type: "undo", at: new Date().toISOString(), number: record.number });
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
  session.events.push(eventForRecord(record, "redo"));
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
  archiveCurrentSession("abandoned");
  startGame(session.mode, session.difficulty);
}

function returnToMenu() {
  archiveCurrentSession("abandoned");
  inputLocked = false;
  paused = false;
  elements.pauseOverlay.hidden = true;
  elements.resultOverlay.hidden = true;
  elements.gameScreen.hidden = true;
  elements.menu.hidden = false;
  elements.continueButton.disabled = !hasSave();
}

function togglePause() {
  if (elements.gameScreen.hidden || session.state.winner || session.state.draw) return;
  paused = !paused;
  elements.pauseOverlay.hidden = !paused;
  renderBoard();
}

function saveGame(status = "active") {
  try {
    localStorage.setItem(SAVE_KEY, JSON.stringify(buildActiveSave(session)));
    if (session.history.length) {
      upsertMatchRecord(localStorage, buildMatchRecord(session, status));
    }
    elements.continueButton.disabled = false;
    updateExportButton();
  } catch {
    showToast("Match storage is full or unavailable.");
  }
}

function archiveCurrentSession(status) {
  if (!session.history.length) return;
  saveGame(status);
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
  restored.events = Array.isArray(data.events)
    ? data.events
    : restored.history.map((record) => eventForRecord(record));
  return restored;
}

function continueGame() {
  try {
    const data = JSON.parse(localStorage.getItem(SAVE_KEY));
    session = sessionFromSave(data);
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
  refreshLegalMoves();
  clearBeams();
  render();
}

function migrateStoredSaveToArchive() {
  try {
    const data = JSON.parse(localStorage.getItem(SAVE_KEY));
    if (![1, SAVE_VERSION].includes(data?.version)) return;
    const restored = sessionFromSave(data);
    localStorage.setItem(SAVE_KEY, JSON.stringify(buildActiveSave(restored)));
    if (restored.history.length) {
      upsertMatchRecord(localStorage, buildMatchRecord(restored));
    }
  } catch {
    // Continue still reports malformed active saves when the user attempts to load one.
  }
}

function updateExportButton() {
  elements.exportLogs.disabled = loadMatchArchive(localStorage).matches.length === 0;
}

function exportMatchLogs() {
  const archive = loadMatchArchive(localStorage);
  if (!archive.matches.length) {
    showToast("No recorded matches yet.");
    return;
  }
  const payload = {
    ...archive,
    exportedAt: new Date().toISOString(),
  };
  const url = URL.createObjectURL(new Blob([`${JSON.stringify(payload, null, 2)}\n`], { type: "application/json" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = `laser-war-match-logs-${new Date().toISOString().slice(0, 10)}.json`;
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
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
elements.exportLogs.addEventListener("click", exportMatchLogs);
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

migrateStoredSaveToArchive();
elements.continueButton.disabled = !hasSave();
updateExportButton();
window.__laserWar = {
  game,
  startGame,
  playMove,
  getSession: () => session,
  getLegalMoves: () => legalMoves,
  getMatchArchive: () => loadMatchArchive(localStorage),
};
