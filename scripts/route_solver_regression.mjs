import { readFileSync } from "node:fs";

import { Cell, Game } from "../web/engine.js";
import { exactJointPathWitness } from "../web/exact_routes.js";

const fixture = JSON.parse(readFileSync(
  new URL("../web/fixtures/ultra_freeze_11_move_log.json", import.meta.url),
  "utf8",
));
const game = new Game();
let state = game.initialState();

const initial = game.initialState();
const initialWitness = exactJointPathWitness(
  initial.board,
  game.sources,
  game.mirrorForbiddenSquares(initial.board),
);
if (!initialWitness) throw new Error("The initial position must have compatible exact routes.");
const completed = initial.board.map((row) => [...row]);
for (let index = 0; index < 81; index += 1) {
  const bit = 1n << BigInt(index);
  const row = Math.floor(index / 9);
  const col = index % 9;
  if (initialWitness.empty & bit) completed[row][col] = Cell.EMPTY;
  else if (initialWitness.slash & bit) completed[row][col] = Cell.SLASH;
  else if (initialWitness.backslash & bit) completed[row][col] = Cell.BACKSLASH;
}
const witnessHits = game.fireLasers(completed).map(({ hitKing }) => hitKing).sort();
if (witnessHits.join(",") !== "bottom,top") {
  throw new Error("The exact route witness must materialize as paths to different kings.");
}

for (const [row, col, mirror] of fixture.moves) {
  state = game.resolveMove(state, {
    row: row - 1,
    col: col - 1,
    mirror,
  }, false, false).state;
}

const pathologicalChild = game.resolveMove(state, {
  row: 2,
  col: 5,
  mirror: "\\",
}, false, false).state;
const forbidden = game.mirrorForbiddenSquares(pathologicalChild.board);
const started = performance.now();
let slowest = 0;
for (let iteration = 0; iteration < 24; iteration += 1) {
  const queryStarted = performance.now();
  exactJointPathWitness(pathologicalChild.board, game.sources, forbidden);
  slowest = Math.max(slowest, performance.now() - queryStarted);
}
for (const rows of fixture.pathologicalBoards) {
  const board = rows.map((row) => [...row]);
  const boardForbidden = game.mirrorForbiddenSquares(board);
  for (let iteration = 0; iteration < 12; iteration += 1) {
    const queryStarted = performance.now();
    const witness = exactJointPathWitness(board, game.sources, boardForbidden);
    if (witness) throw new Error("Pathological freeze fixture must remain incompatible.");
    slowest = Math.max(slowest, performance.now() - queryStarted);
  }
}

console.log(
  `Exact route canonicalization passed · valid witness + 48 UNSAT queries`
  + ` · ${Math.round(performance.now() - started)} ms total`
  + ` · ${Math.round(slowest)} ms slowest`,
);
