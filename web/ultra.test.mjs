import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { routePressureScore, UltraSearch } from "./ai.js";
import { Game } from "./engine.js";

const TEST_PROFILE = {
  timeLimit: Infinity,
  maxDepth: 4,
  rootLimit: 24,
  branchLimits: [22, 12, 8],
};
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
  state = game.resolveMove(state, { row, col, mirror }, false, false).state;
}

const search = new UltraSearch(game, () => 0, TEST_PROFILE);
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
  }, false, false).state;
}
const horizonSearch = new UltraSearch(game, () => 0, TEST_PROFILE);
const horizonScore = horizonSearch.stabilizedEvaluation(forcedState, 4);
assert.equal(horizonScore, -9995);
assert.ok(horizonSearch.legalityCache.size > 0);

const reportedFixture = JSON.parse(readFileSync(
  new URL("../tests/fixtures/ultra_loss_30_move_log.json", import.meta.url),
));
let reportedState = game.initialState();
for (const [row, col, mirror] of reportedFixture.moves.slice(0, 29)) {
  reportedState = game.resolveMove(reportedState, {
    row: row - 1,
    col: col - 1,
    mirror,
  }).state;
}
const reportedSearch = new UltraSearch(game, () => 0, TEST_PROFILE);
const tacticalChildren = reportedSearch.orderedChildren(reportedState, 4);
const apparentSurvivals = tacticalChildren.filter(
  ({ state: child }) => child.winner !== "bottom",
);
assert.equal(game.legalChildren(reportedState, false).length, 68);
assert.equal(game.legalChildren(reportedState).length, 67);
assert.equal(apparentSurvivals.length, 1);
assert.deepEqual(reportedSearch.strictSubset(reportedState, apparentSurvivals, 8), []);
assert.equal(reportedSearch.stabilizedEvaluation(reportedState, 4), -9995);

const protectedState = game.initialState("top");
const pressureSearch = new UltraSearch(game, () => 0, TEST_PROFILE);
const protectedScore = pressureSearch.strategicEvaluation(protectedState);
const exposedState = structuredClone(protectedState);
exposedState.board[7][4] = ".";
assert.ok(pressureSearch.strategicEvaluation(exposedState) > protectedScore);
const controlledRoutes = [{ top: 4, bottom: 4 }, { top: 2, bottom: 10 }];
const counteredRoutes = [{ top: 4, bottom: 2 }, { top: 2, bottom: 10 }];
assert.ok(routePressureScore(controlledRoutes, "top", "bottom") < 0);
assert.ok(
  routePressureScore(counteredRoutes, "top", "bottom")
  > routePressureScore(controlledRoutes, "top", "bottom"),
);
assert.equal(
  routePressureScore(controlledRoutes, "top", "bottom"),
  -routePressureScore(controlledRoutes, "bottom", "top"),
);

const earlyLossFixture = JSON.parse(readFileSync(
  new URL("../tests/fixtures/ultra_loss_10_move_log.json", import.meta.url),
));
let earlyLossState = game.initialState();
for (const [row, col, mirror] of earlyLossFixture.moves.slice(0, 9)) {
  earlyLossState = game.resolveMove(earlyLossState, {
    row: row - 1,
    col: col - 1,
    mirror,
  }).state;
}
const loggedMove = game.resolveMove(
  earlyLossState,
  { row: 2, col: 2, mirror: "/" },
  false,
).state;
const counterMove = game.resolveMove(
  earlyLossState,
  { row: 0, col: 2, mirror: "\\" },
  false,
).state;
const counterplaySearch = new UltraSearch(game, () => 0, TEST_PROFILE);
assert.deepEqual(
  game.routeCostsByLaser(earlyLossState.board),
  [{ top: 2, bottom: 8 }, { top: 2, bottom: 3 }],
);
assert.ok(
  counterplaySearch.strategicEvaluation(counterMove)
  < counterplaySearch.strategicEvaluation(loggedMove) - 250,
);

const filteredSearch = new UltraSearch(game, () => 0, TEST_PROFILE);
filteredSearch.orderedChildren = () => [{
  move: { row: 0, col: 0, mirror: "/" },
  state: game.initialState("bottom"),
}];
filteredSearch.strictSubset = () => [];
assert.equal(filteredSearch.negamax(game.initialState("top"), 1, -Infinity, Infinity, 1), 0);

const productionSearch = new UltraSearch(game, () => 0);
assert.ok(productionSearch.profile.maxDepth >= 8);
assert.deepEqual(productionSearch.softTiming(game.initialState(), 0), {
  latePosition: false,
  softDeadline: 2250,
});

console.log(
  `Ultra horizon check passed at depth ${result.depth} `
  + `(${result.nodes.toLocaleString()} positions, ${Math.round(result.elapsed)} ms).`,
);
