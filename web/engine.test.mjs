import assert from "node:assert/strict";

import { chooseComputerMove } from "./ai.js";
import { Cell, Game } from "./engine.js";

const game = new Game();
const initial = game.initialState();

assert.equal(initial.board[0][4], Cell.TOP_KING);
assert.equal(initial.board[8][4], Cell.BOTTOM_KING);
assert.equal(game.legalMoves(initial).length, 130);
assert.equal(game.isLegalMove(initial, { row: 4, col: 0, mirror: Cell.SLASH }), false);
assert.equal(game.isLegalMove(initial, { row: 4, col: 8, mirror: Cell.BACKSLASH }), false);

const next = game.resolveMove(initial, { row: 4, col: 4, mirror: Cell.SLASH }).state;
assert.equal(next.board[4][4], Cell.SLASH);
assert.equal(next.turn, "top");

const exposed = game.initialState();
exposed.board[1][4] = Cell.EMPTY;
assert.equal(game.isLegalMove(exposed, { row: 1, col: 4, mirror: Cell.SLASH }), false);

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
  strandingState = game.resolveMove(strandingState, { row, col, mirror }).state;
}
assert.equal(game.isLegalMove(strandingState, { row: 0, col: 7, mirror: "\\" }), false);

const tacticalGame = {
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

console.log("Native web engine checks passed.");
