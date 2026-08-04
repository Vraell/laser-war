import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { ExactLateGameSolver, ExactOutcome, canonicalState, transformMove } from "./endgame.js";
import { Game } from "./engine.js";

/** Replay a fixture prefix through the authoritative game rules. */
function replay(name, plies) {
  const fixture = JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8"));
  const game = new Game();
  let state = game.initialState();
  for (const [row, col, mirror] of fixture.moves.slice(0, plies)) {
    state = game.resolveMove(state, { row: row - 1, col: col - 1, mirror }).state;
  }
  return { game, state };
}

/** Build an equivalent state under one supported, self-inverse symmetry. */
function transformState(state, transform) {
  const board = Array.from({ length: 9 }, () => Array(9).fill("."));
  for (let row = 0; row < 9; row += 1) {
    for (let col = 0; col < 9; col += 1) {
      const coordinates = transformMove({ row, col, mirror: "/" }, transform);
      let cell = state.board[row][col];
      if (cell === "/" || cell === "\\") {
        cell = transformMove({ row, col, mirror: cell }, transform).mirror;
      }
      if (transform >= 2) {
        if (cell === "k") cell = "K";
        else if (cell === "K") cell = "k";
      }
      board[coordinates.row][coordinates.col] = cell;
    }
  }
  const opposite = (side) => side === "top" ? "bottom" : side === "bottom" ? "top" : side;
  return {
    board,
    turn: transform >= 2 ? opposite(state.turn) : state.turn,
    winner: transform >= 2 ? opposite(state.winner) : state.winner,
    draw: state.draw,
  };
}

const late = replay("ultra_choke_46_move_log.json", 45);
const tablebase = new Map();
const solver = new ExactLateGameSolver(late.game, {
  tablebase,
  maxNodes: 100_000,
  timeLimit: Infinity,
  now: () => 0,
});
const result = solver.solve(late.state);
assert.equal(result.status, "exact");
assert.equal(result.outcome, ExactOutcome.WIN);
assert.deepEqual(result.bestMove, { row: 7, col: 8, mirror: "/" });
assert.equal(late.game.resolveMove(late.state, result.bestMove).state.winner, late.state.turn);

const horizontal = transformState(late.state, 1);
assert.equal(canonicalState(late.state).key, canonicalState(horizontal).key);
const cached = solver.solve(horizontal, { maxNodes: 2 });
assert.equal(cached.status, "exact");
assert.equal(cached.outcome, ExactOutcome.WIN);
assert.deepEqual(cached.bestMove, transformMove(result.bestMove, 1));

const boundedTablebase = new Map();
const bounded = new ExactLateGameSolver(new Game(), {
  tablebase: boundedTablebase,
  maxNodes: 1,
  timeLimit: Infinity,
  now: () => 0,
});
const unknown = bounded.solve(new Game().initialState());
assert.equal(unknown.status, "unknown");
assert.equal(unknown.outcome, undefined);
assert.equal(boundedTablebase.size, 0, "An interrupted root must not be cached as exact.");

const fullBoard = Array.from({ length: 9 }, () => Array(9).fill("/"));
fullBoard[0][4] = "k";
fullBoard[8][4] = "K";
const draw = new ExactLateGameSolver(new Game(), { now: () => 0 }).solve({
  board: fullBoard,
  turn: "top",
  winner: null,
  draw: false,
});
assert.equal(draw.status, "exact");
assert.equal(draw.outcome, ExactOutcome.DRAW);

console.log("Exact late-game solver checks passed.");
