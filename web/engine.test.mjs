import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { chooseComputerMove } from "./ai.js";
import { Cell, Game } from "./engine.js";

const game = new Game();
const initial = game.initialState();

assert.equal(initial.board[0][4], Cell.TOP_KING);
assert.equal(initial.board[8][4], Cell.BOTTOM_KING);
const mutuallyExposed = game.initialState("top");
mutuallyExposed.board = Array.from({ length: 9 }, () => Array(9).fill(Cell.EMPTY));
mutuallyExposed.board[4][2] = Cell.TOP_KING;
mutuallyExposed.board[4][6] = Cell.BOTTOM_KING;
assert.equal(game.evaluate(mutuallyExposed), 0);
assert.equal(game.legalMoves(initial).length, 130);
assert.equal(game.isLegalMove(initial, { row: 4, col: 0, mirror: Cell.SLASH }), false);
assert.equal(game.isLegalMove(initial, { row: 4, col: 8, mirror: Cell.BACKSLASH }), false);
assert.equal(game.illegalMoveReason(initial, { row: 4, col: 0, mirror: Cell.SLASH }), "laserEntry");
assert.equal(game.illegalMoveReason(initial, { row: 0, col: 4, mirror: Cell.SLASH }), "occupiedKing");
assert.equal(game.illegalMoveReason(initial, { row: 0, col: 3, mirror: Cell.SLASH }), "occupiedShield");

const next = game.resolveMove(initial, { row: 4, col: 4, mirror: Cell.SLASH }).state;
assert.equal(next.board[4][4], Cell.SLASH);
assert.equal(next.turn, "top");

const exposed = game.initialState();
exposed.board[1][4] = Cell.EMPTY;
assert.equal(game.isLegalMove(exposed, { row: 1, col: 4, mirror: Cell.SLASH }), false);
assert.equal(game.illegalMoveReason(exposed, { row: 1, col: 4, mirror: Cell.SLASH }), "kingAdjacent");

const reachability = game.reachableKingsByLaser(initial.board);
assert.deepEqual([...reachability[0]].sort(), ["bottom", "top"]);
assert.deepEqual([...reachability[1]].sort(), ["bottom", "top"]);

const fortress = [
  ".\\\\.kO//\\",
  "\\...../..",
  "\\\\./////.",
  ".//\\/\\.\\.",
  "./.../.\\.",
  ".........",
  "....\\....",
  "....O....",
  "...OK....",
].map((row) => [...row]);
const fortressReachability = game.reachableKingsByLaser(fortress);
assert.equal(fortressReachability.some((kings) => kings.has("top")), false);
assert.equal(fortressReachability.some((kings) => kings.has("bottom")), true);

const crossing = [
  "...OkO...",
  "...OOO\\..",
  "....O./..",
  "\\.....\\..",
  ".\\.....\\.",
  "\\/......\\",
  "....O....",
  "...OOO...",
  "...OKO...",
].map((row) => [...row]);
const crossingReachability = game.reachableKingsByLaser(crossing);
assert.equal(crossingReachability.some((kings) => kings.has("top")), true);
assert.equal(crossingReachability.some((kings) => kings.has("bottom")), false);

let strandingState = game.initialState();
const strandingSetup = [
  [4, 7, "\\"], [8, 7, "/"], [4, 1, "/"], [0, 0, "/"], [0, 1, "/"], [0, 2, "/"],
  [1, 1, "/"], [1, 2, "\\"], [2, 2, "\\"], [2, 4, "\\"], [3, 1, "\\"], [3, 7, "\\"],
  [3, 6, "\\"], [2, 6, "/"], [2, 7, "/"], [1, 7, "/"], [1, 8, "/"], [0, 6, "\\"], [0, 8, "\\"],
];
for (const [row, col, mirror] of strandingSetup) {
  strandingState = game.resolveMove(strandingState, { row, col, mirror }, false, false).state;
}
assert.equal(game.isLegalMove(strandingState, { row: 0, col: 7, mirror: "\\" }), false);
assert.equal(game.illegalMoveReason(strandingState, { row: 0, col: 7, mirror: "\\" }), "rightLaserStranded");

const tacticalGame = {
  isLegalMove() {
    return true;
  },
  legalChildren(state) {
    if (state.kind === "root") {
      return Array.from({ length: 16 }, (_, index) => ({
        move: { index },
        state: { kind: "candidate", index, turn: "bottom", winner: null, draw: false },
      }));
    }
    if (state.kind === "candidate") {
      return [{
        move: { reply: true },
        state: {
          kind: "reply",
          index: state.index,
          turn: "top",
          winner: state.index === 14 ? "bottom" : null,
          draw: false,
        },
      }];
    }
    return [];
  },
  evaluate(state) {
    if (state.kind === "candidate") return -(100 - state.index);
    if (state.winner === "bottom") return -10000;
    return 0;
  },
};
const tacticalChoice = chooseComputerMove(
  tacticalGame,
  { kind: "root", turn: "top", winner: null, draw: false },
  "hard",
);
assert.equal(tacticalChoice.move.index, 0);

let selfKillState = game.initialState();
const selfKillSetup = [
  [4, 1, "/"],
  [8, 1, "\\"],
  [4, 7, "\\"],
  [0, 0, "/"],
  [0, 7, "\\"],
];
for (const [row, col, mirror] of selfKillSetup) {
  selfKillState = game.resolveMove(selfKillState, { row, col, mirror }).state;
}
const selfKill = { row: 0, col: 1, mirror: "/" };
const correctedChoice = chooseComputerMove(game, selfKillState, "hard");
const correctedOutcome = game.resolveMove(selfKillState, correctedChoice.move, false);
assert.notDeepEqual(correctedChoice.move, selfKill);
assert.notEqual(correctedOutcome.state.winner, "bottom");

const forcedLossFixture = JSON.parse(readFileSync(
  new URL("./fixtures/forced_loss_40_move_log.json", import.meta.url),
  "utf8",
));
let forcedLossState = game.initialState();
for (const [row, col, mirror] of forcedLossFixture.moves.slice(0, -1)) {
  forcedLossState = game.resolveMove(
    forcedLossState,
    { row: row - 1, col: col - 1, mirror },
    false,
    false,
  ).state;
}
const [reportedRow, reportedCol, reportedMirror] = forcedLossFixture.moves.at(-1);
const reportedMove = { row: reportedRow - 1, col: reportedCol - 1, mirror: reportedMirror };
assert.equal(game.illegalMoveReason(forcedLossState, reportedMove), "rightLaserStranded");
const forcedChoice = chooseComputerMove(game, forcedLossState, "hard");
assert.equal(game.isLegalMove(forcedLossState, forcedChoice.move), true);
assert.equal(game.resolveMove(forcedLossState, forcedChoice.move).state.winner, "bottom");

const incompatibleFixture = JSON.parse(readFileSync(
  new URL("./fixtures/incompatible_28_move_log.json", import.meta.url),
  "utf8",
));
let incompatibleState = game.initialState();
for (const [row, col, mirror] of incompatibleFixture.moves.slice(0, 25)) {
  incompatibleState = game.resolveMove(
    incompatibleState,
    { row: row - 1, col: col - 1, mirror },
  ).state;
}
const [closingRow, closingCol, closingMirror] = incompatibleFixture.moves[25];
const closingMove = { row: closingRow - 1, col: closingCol - 1, mirror: closingMirror };
const legacyOutcome = game.resolveMove(incompatibleState, closingMove, false, false);
assert.deepEqual(
  game.reachableKingsByLaser(legacyOutcome.state.board).map((kings) => [...kings].sort()),
  [["bottom", "top"], ["bottom", "top"]],
);
assert.equal(game.jointPathsAvailable(legacyOutcome.state.board), false);
assert.equal(
  game.jointPathPreserved(incompatibleState.board, legacyOutcome.state.board, closingMove),
  false,
);
assert.equal(game.illegalMoveReason(incompatibleState, closingMove), "incompatiblePaths");

const witnessFixture = JSON.parse(readFileSync(
  new URL("./fixtures/ultra_loss_18_move_log.json", import.meta.url),
  "utf8",
));
const acceleratedGame = new Game();
let witnessState = acceleratedGame.initialState();
for (const [row, col, mirror] of witnessFixture.moves.slice(0, 13)) {
  witnessState = acceleratedGame.resolveMove(witnessState, {
    row: row - 1,
    col: col - 1,
    mirror,
  }).state;
}
const exactGame = new Game();
for (const { move, state: child } of acceleratedGame.legalChildren(witnessState, false)) {
  assert.equal(
    acceleratedGame.jointPathPreserved(witnessState.board, child.board, move),
    exactGame.jointPathsAvailable(child.board),
  );
}

const budgetBoard = [
  "\\..OkO/.\\",
  "/.\\OOO./\\",
  "/\\\\\\O/../",
  "/..\\//\\..",
  ".///\\....",
  "\\\\./.\\\\./",
  "..\\/O//\\\\",
  "..\\......",
  "//\\.KO..\\",
].map((row) => [...row]);
const budgetState = {
  board: budgetBoard,
  turn: "top",
  winner: null,
  draw: false,
};
const budgetGame = new Game();
const budgetChildren = budgetGame.legalChildren(budgetState, false);
const learnedMove = { row: 4, col: 6, mirror: "/" };
const rejectedMove = { row: 4, col: 5, mirror: "/" };
const learnedChild = budgetChildren.find(({ move }) => (
  move.row === learnedMove.row && move.col === learnedMove.col && move.mirror === learnedMove.mirror
));
const rejectedChild = budgetChildren.find(({ move }) => (
  move.row === rejectedMove.row && move.col === rejectedMove.col && move.mirror === rejectedMove.mirror
));
assert.equal(
  budgetGame.jointPathPreserved(budgetBoard, learnedChild.state.board, learnedMove),
  true,
);
assert.equal(new Game().jointPathsAvailable(rejectedChild.state.board), true);
assert.equal(
  budgetGame.jointPathPreserved(budgetBoard, rejectedChild.state.board, rejectedMove),
  true,
);

const horizonGame = new Game();
let horizonState = horizonGame.initialState();
for (const [row, col, mirror] of [
  [5, 8, "\\"], [9, 8, "/"], [5, 2, "/"], [1, 3, "\\"], [1, 8, "\\"],
  [1, 7, "/"], [4, 7, "\\"], [3, 6, "\\"], [4, 3, "/"], [4, 2, "\\"],
]) {
  horizonState = horizonGame.resolveMove(horizonState, {
    row: row - 1,
    col: col - 1,
    mirror,
  }).state;
}
for (const [row, col] of [[3, 7], [4, 9], [6, 1]]) {
  const move = { row: row - 1, col: col - 1, mirror: "/" };
  assert.equal(
    horizonGame.isLegalMove(horizonState, move),
    true,
    `R${row}C${col} should not be rejected by the fast solver's mirror horizon.`,
  );
  const child = horizonGame.resolveMove(horizonState, move, false, false).state;
  const witness = horizonGame.jointPathWitness(child.board);
  const completed = child.board.map((boardRow) => boardRow.map(
    (cell) => cell === Cell.SHIELD ? Cell.EMPTY : cell,
  ));
  for (let index = 0; index < 81; index += 1) {
    const bit = 1n << BigInt(index);
    const witnessMirror = witness.slash & bit
      ? Cell.SLASH
      : witness.backslash & bit ? Cell.BACKSLASH : null;
    if (witnessMirror && completed[Math.floor(index / 9)][index % 9] === Cell.EMPTY) {
      completed[Math.floor(index / 9)][index % 9] = witnessMirror;
    }
  }
  assert.deepEqual(
    horizonGame.fireLasers(completed).map(({ hitKing }) => hitKing).sort(),
    ["bottom", "top"],
  );
}

console.log("Web engine checks passed.");
