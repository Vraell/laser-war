import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { UltraSearch } from "./ai.js";
import { Game } from "./engine.js";

const game = new Game();
let state = game.initialState();
const setup = [
  [4, 1, "/"],
  [8, 1, "\\"],
  [4, 7, "\\"],
  [0, 0, "/"],
  [1, 7, "\\"],
  [0, 1, "\\"],
  [1, 2, "\\"],
  [0, 2, "\\"],
  [0, 6, "\\"],
  [1, 6, "/"],
  [2, 7, "\\"],
  [2, 5, "/"],
  [3, 7, "/"],
  [7, 0, "\\"],
  [5, 0, "/"],
  [2, 2, "/"],
  [3, 4, "/"],
  [3, 2, "\\"],
  [2, 3, "\\"],
  [0, 7, "/"],
  [4, 3, "/"],
];

for (const [row, col, mirror] of setup) {
  state = game.resolveMove(state, { row, col, mirror }).state;
}

const search = new UltraSearch(game, () => 0);
const result = search.choose(state);

assert.ok(result.depth >= 4, `Ultra only completed depth ${result.depth}.`);
assert.ok(game.isLegalMove(state, result.move));
assert.notDeepEqual(result.move, { row: 0, col: 8, mirror: "/" });
assert.ok(search.killers.size > 0, "Ultra should retain cutoff moves for ordering.");

const fixture = JSON.parse(readFileSync(
  new URL("../tests/fixtures/forced_loss_40_move_log.json", import.meta.url),
));
let forcedState = game.initialState();
for (const [row, col, mirror] of fixture.moves.slice(0, -1)) {
  forcedState = game.resolveMove(forcedState, {
    row: row - 1,
    col: col - 1,
    mirror,
  }).state;
}
const horizonSearch = new UltraSearch(game, () => 0);
const horizonScore = horizonSearch.stabilizedEvaluation(forcedState, 4);
assert.equal(horizonScore, -9995);
assert.ok(horizonSearch.nodes > 0);

console.log(
  `Ultra horizon check passed at depth ${result.depth} `
  + `(${result.nodes.toLocaleString()} positions, ${Math.round(result.elapsed)} ms).`,
);
