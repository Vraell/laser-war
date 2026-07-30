import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { routePressureScore, UltraSearch } from "./ai.js";
import { Game } from "./engine.js";
import { TacticalProofSearch } from "./tactics.js";

const TEST_PROFILE = {
  timeLimit: Infinity,
  maxDepth: 4,
  rootLimit: 24,
  branchLimits: [22, 12, 8],
  proofMaxNodes: 0,
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

const progressEvents = [];
const search = new UltraSearch(game, () => 0, TEST_PROFILE, (progressEvent) => {
  progressEvents.push(progressEvent);
});
const result = search.choose(state);

assert.ok(result.depth >= 4, `Ultra only completed depth ${result.depth}.`);
assert.ok(game.isLegalMove(state, result.move));
assert.notDeepEqual(result.move, { row: 0, col: 8, mirror: "/" });
assert.ok(search.killers.size > 0, "Ultra should retain cutoff moves for ordering.");

assert.equal(progressEvents[0].phase, "preparing");
assert.ok(progressEvents.some(({ phase, depth }) => phase === "searching" && depth >= 1));
assert.ok(progressEvents.some(({ nodes }) => nodes > 0));
const completedProgress = progressEvents.find(({ best }) => best?.move);
assert.ok(completedProgress, "Ultra should publish a validated fallback before deep search.");
assert.ok(game.isLegalMove(state, completedProgress.best.move));

const fixture = JSON.parse(readFileSync(
  new URL("./fixtures/forced_loss_40_move_log.json", import.meta.url),
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

const reportedFixture = JSON.parse(readFileSync(
  new URL("./fixtures/ultra_loss_30_move_log.json", import.meta.url),
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

const forcingFixture = JSON.parse(readFileSync(
  new URL("./fixtures/ultra_loss_18_move_log.json", import.meta.url),
));
let forcingState = game.initialState();
for (const [row, col, mirror] of forcingFixture.moves.slice(0, 16)) {
  forcingState = game.resolveMove(forcingState, {
    row: row - 1,
    col: col - 1,
    mirror,
  }).state;
}
const forcingSearch = new UltraSearch(game, () => 0, TEST_PROFILE);
assert.equal(forcingSearch.forcingSetupScore(forcingState, 3), null);
const [forcingRow, forcingCol, forcingMirror] = forcingFixture.moves[16];
const exposedStateFromLog = game.resolveMove(forcingState, {
  row: forcingRow - 1,
  col: forcingCol - 1,
  mirror: forcingMirror,
}).state;
assert.equal(forcingSearch.isForcedExposure(exposedStateFromLog), false);
assert.deepEqual(
  game.legalChildren(exposedStateFromLog)
    .filter(({ state: child }) => child.winner !== "bottom")
    .map(({ move }) => move),
  [{ row: 2, col: 3, mirror: "\\" }],
);
const escapeSearch = new UltraSearch(game, () => 0, {
  timeLimit: Infinity,
  maxDepth: 1,
  rootLimit: 12,
  branchLimits: [10, 8, 6],
});
assert.deepEqual(
  escapeSearch.choose(exposedStateFromLog).move,
  { row: 2, col: 3, mirror: "\\" },
);

const decisionGame = new Game();
let decisionState = decisionGame.initialState();
for (const [row, col, mirror] of forcingFixture.moves.slice(0, 13)) {
  decisionState = decisionGame.resolveMove(decisionState, {
    row: row - 1,
    col: col - 1,
    mirror,
  }).state;
}
const decisionSearch = new UltraSearch(decisionGame, () => 0, {
  timeLimit: Infinity,
  maxDepth: 3,
  rootLimit: 12,
  branchLimits: [10, 8, 6],
});
const defensiveDecision = decisionSearch.choose(decisionState);
assert.equal(defensiveDecision.depth, 3);
assert.deepEqual(defensiveDecision.move, { row: 3, col: 3, mirror: "\\" });

const protectedState = game.initialState("top");
const pressureSearch = new UltraSearch(game, () => 0, TEST_PROFILE);
const protectedScore = pressureSearch.strategicEvaluation(protectedState);
const protectedComponents = pressureSearch.strategicEvaluationComponents(protectedState);
assert.deepEqual(pressureSearch.shieldCounts(protectedState.board), {
  top: 6,
  bottom: 6,
});
assert.equal(
  pressureSearch.shieldCounts(protectedState.board).top,
  game.nearbyShields(protectedState.board, "k"),
);
assert.equal(
  pressureSearch.shieldCounts(protectedState.board).bottom,
  game.nearbyShields(protectedState.board, "K"),
);
assert.equal(
  Object.values(protectedComponents).reduce((total, value) => total + value, 0),
  protectedScore,
);
assert.deepEqual(Object.keys(protectedComponents), [
  "terminal",
  "shieldCount",
  "assignmentControl",
  "routeControl",
  "exposure",
]);
const exposedState = structuredClone(protectedState);
exposedState.board[7][4] = ".";
assert.ok(pressureSearch.strategicEvaluation(exposedState) > protectedScore);

const symmetricExposureGame = {
  nearbyShields() {
    return 0;
  },
  reachableKingMasksByLaser() {
    return [3, 3];
  },
  routeCostsByLaser() {
    return [{ top: 2, bottom: 2 }, { top: 3, bottom: 3 }];
  },
  fireLasers() {
    return [{ hitKing: "top" }, { hitKing: "bottom" }];
  },
};
const symmetricExposureSearch = new UltraSearch(
  symmetricExposureGame,
  () => 0,
  TEST_PROFILE,
);
const symmetricExposureState = {
  board: game.initialState().board,
  turn: "top",
  winner: null,
  draw: false,
};
assert.equal(
  symmetricExposureSearch.strategicEvaluationComponents(symmetricExposureState).exposure,
  0,
);
const terminalComponents = pressureSearch.strategicEvaluationComponents({
  ...protectedState,
  winner: "top",
});
assert.equal(terminalComponents.terminal, 10000);
assert.equal(
  Object.entries(terminalComponents)
    .filter(([name]) => name !== "terminal")
    .reduce((total, [, value]) => total + value, 0),
  0,
);
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
  new URL("./fixtures/ultra_loss_10_move_log.json", import.meta.url),
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

const freezeFixture = JSON.parse(readFileSync(
  new URL("./fixtures/ultra_freeze_13_move_log.json", import.meta.url),
));
const freezeGame = new Game();
let freezeState = freezeGame.initialState();
for (const [row, col, mirror] of freezeFixture.moves) {
  freezeState = freezeGame.resolveMove(freezeState, {
    row: row - 1,
    col: col - 1,
    mirror,
  }).state;
}
const freezeSearch = new UltraSearch(freezeGame, () => performance.now(), {
  timeLimit: 3500,
  maxDepth: 3,
  rootLimit: 16,
  branchLimits: [14, 10, 7],
});
const freezeStarted = performance.now();
const freezeResult = freezeSearch.choose(freezeState);
assert.ok(performance.now() - freezeStarted < 3500, "Ultra exceeded the freeze regression budget.");
assert.ok(freezeResult.depth >= 2, "Ultra should search beyond its fallback in the reported position.");
assert.ok(freezeGame.isLegalMove(freezeState, freezeResult.move));

const reportedFifteenMoveFixture = JSON.parse(readFileSync(
  new URL("./fixtures/ultra_loss_15_move_log.json", import.meta.url),
));
const fifteenMoveGame = new Game();
let fifteenMoveState = fifteenMoveGame.initialState();
for (const [row, col, mirror] of reportedFifteenMoveFixture.moves.slice(0, 11)) {
  fifteenMoveState = fifteenMoveGame.resolveMove(fifteenMoveState, {
    row: row - 1,
    col: col - 1,
    mirror,
  }).state;
}
const fifteenMoveSearch = new UltraSearch(fifteenMoveGame, () => 0, {
  timeLimit: Infinity,
  maxDepth: 3,
  rootLimit: 16,
  branchLimits: [22, 14, 10],
});
assert.deepEqual(
  fifteenMoveSearch.choose(fifteenMoveState).move,
  { row: 4, col: 6, mirror: "/" },
);

const loggedBlunderState = fifteenMoveGame.resolveMove(
  fifteenMoveState,
  { row: 4, col: 2, mirror: "/" },
).state;
const fifteenMoveProof = new TacticalProofSearch(fifteenMoveGame).prove(
  loggedBlunderState,
  "bottom",
  3,
);
assert.equal(fifteenMoveProof.status, "proven");
assert.deepEqual(fifteenMoveProof.line, [
  { row: 2, col: 5, mirror: "\\" },
  { row: 2, col: 2, mirror: "/" },
  { row: 2, col: 4, mirror: "/" },
]);

const rootPruningFixture = JSON.parse(readFileSync(
  new URL("./fixtures/ultra_root_pruning_31_move_log.json", import.meta.url),
));
let rootPruningState = game.initialState();
for (const [row, col, mirror] of rootPruningFixture.moves.slice(0, 23)) {
  rootPruningState = game.resolveMove(rootPruningState, {
    row: row - 1,
    col: col - 1,
    mirror,
  }).state;
}
const narrowRootSearch = new UltraSearch(game, () => 0, {
  timeLimit: Infinity,
  maxDepth: 2,
  rootLimit: 16,
  branchLimits: [14, 10, 7],
  includeForcingRoots: false,
});
assert.deepEqual(
  narrowRootSearch.choose(rootPruningState).move,
  { row: 2, col: 2, mirror: "/" },
);
const threatAwareRootSearch = new UltraSearch(game, () => 0, {
  timeLimit: Infinity,
  maxDepth: 2,
  rootLimit: 16,
  branchLimits: [14, 10, 7],
});
const threatAwareMove = threatAwareRootSearch.choose(rootPruningState).move;
assert.deepEqual(threatAwareMove, { row: 2, col: 2, mirror: "/" });
assert.ok(
  threatAwareRootSearch.shieldExchange(
    rootPruningState,
    game.resolveMove(rootPruningState, threatAwareMove).state,
  ) >= 0,
);
assert.equal(
  threatAwareRootSearch.shouldExtendSearch(
    { move: { row: 2, col: 2, mirror: "/" }, score: 272 },
    { move: { row: 5, col: 1, mirror: "\\" }, score: -27 },
    true,
  ),
  true,
);
assert.equal(
  threatAwareRootSearch.shouldExtendSearch(
    { move: { row: 2, col: 2, mirror: "/" }, score: 272 },
    { move: { row: 5, col: 1, mirror: "\\" }, score: -27 },
  ),
  false,
);
assert.equal(
  threatAwareRootSearch.shouldExtendSearch(
    { move: { row: 5, col: 1, mirror: "\\" }, score: -20 },
    { move: { row: 5, col: 1, mirror: "\\" }, score: -35 },
    true,
  ),
  false,
);

const filteredSearch = new UltraSearch(game, () => 0, TEST_PROFILE);
filteredSearch.orderedChildren = () => [{
  move: { row: 0, col: 0, mirror: "/" },
  state: game.initialState("bottom"),
}];
filteredSearch.strictSubset = () => [];
assert.equal(filteredSearch.negamax(game.initialState("top"), 1, -Infinity, Infinity, 1), 0);

const productionSearch = new UltraSearch(game, () => 0);
assert.ok(productionSearch.profile.maxDepth >= 12);
assert.equal(productionSearch.profile.timeLimit, 10000);
assert.equal(productionSearch.profile.rootLimit, 16);
assert.equal(productionSearch.profile.tacticalForcingRootLimit, 6);
assert.deepEqual(productionSearch.profile.branchLimits, [22, 14, 10]);
assert.deepEqual(productionSearch.softTiming(game.initialState(), 0), {
  latePosition: false,
  softDeadline: 4000,
});
const openingChildren = game.legalChildren(game.initialState()).slice(0, 3);
const varietySearch = new UltraSearch(game, () => 0, TEST_PROFILE, () => {}, () => 0.99);
const varietyState = game.initialState();
const varietyKey = varietySearch.keyForState(varietyState);
varietySearch.childrenCache.set(varietyKey, openingChildren);
varietySearch.rootScores.set(varietyKey, new Map([
  [((openingChildren[0].move.row * 9 + openingChildren[0].move.col) * 2), 120],
  [((openingChildren[1].move.row * 9 + openingChildren[1].move.col) * 2) + 1, 120],
  [((openingChildren[2].move.row * 9 + openingChildren[2].move.col) * 2), 119],
]));
varietySearch.strategicEvaluation = () => -120;
assert.deepEqual(
  varietySearch.openingVariation(
    varietyState,
    varietyKey,
    openingChildren[0].move,
    120,
    { latePosition: false },
  ),
  openingChildren[1].move,
);

const reversedLossFixture = JSON.parse(readFileSync(
  new URL("./fixtures/ultra_loss_reversed_28_move_log.json", import.meta.url),
));
let reversedOpeningState = game.initialState();
for (const [row, col, mirror] of reversedLossFixture.moves.slice(0, 2)) {
  reversedOpeningState = game.resolveMove(reversedOpeningState, {
    row: row - 1,
    col: col - 1,
    mirror,
  }).state;
}
const safeOpeningMove = { row: 0, col: 7, mirror: "\\" };
const weakerTiedOpeningMove = { row: 4, col: 5, mirror: "/" };
const reversedOpeningChildren = [safeOpeningMove, weakerTiedOpeningMove].map((move) => ({
  move,
  state: game.resolveMove(reversedOpeningState, move).state,
}));
const reversedVariationSearch = new UltraSearch(
  game,
  () => 0,
  TEST_PROFILE,
  () => {},
  () => 0.99,
);
const reversedOpeningKey = reversedVariationSearch.keyForState(reversedOpeningState);
reversedVariationSearch.childrenCache.set(reversedOpeningKey, reversedOpeningChildren);
reversedVariationSearch.rootScores.set(reversedOpeningKey, new Map([
  [((safeOpeningMove.row * 9 + safeOpeningMove.col) * 2) + 1, -68],
  [((weakerTiedOpeningMove.row * 9 + weakerTiedOpeningMove.col) * 2), -68],
]));
assert.equal(
  reversedVariationSearch.shieldExchange(
    reversedOpeningState,
    reversedOpeningChildren[1].state,
  ),
  1,
);
assert.ok(
  -reversedVariationSearch.strategicEvaluation(reversedOpeningChildren[0].state)
    > -reversedVariationSearch.strategicEvaluation(reversedOpeningChildren[1].state),
);
assert.deepEqual(
  reversedVariationSearch.openingVariation(
    reversedOpeningState,
    reversedOpeningKey,
    safeOpeningMove,
    -68,
    { latePosition: false },
  ),
  safeOpeningMove,
  "Opening variety must not replace the best move with a strategically weaker search tie.",
);

let reversedCounterplayState = game.initialState();
for (const [row, col, mirror] of reversedLossFixture.moves.slice(0, 16)) {
  reversedCounterplayState = game.resolveMove(reversedCounterplayState, {
    row: row - 1,
    col: col - 1,
    mirror,
  }).state;
}
const reversedCounterplaySearch = new UltraSearch(game, () => 0, {
  ...TEST_PROFILE,
  maxDepth: 4,
  rootLimit: 16,
  tacticalForcingRootLimit: 6,
  branchLimits: [22, 14, 10],
});
assert.equal(reversedCounterplaySearch.isTacticalPosition(reversedCounterplayState), true);
assert.equal(reversedCounterplaySearch.needsForcingCounterplay(reversedCounterplayState), true);
assert.deepEqual(
  reversedCounterplaySearch.choose(reversedCounterplayState).move,
  { row: 5, col: 1, mirror: "/" },
  "Ultra must retain the strongest live-beam counterplay outside the quiet root limit.",
);
const commonOpeningState = game.resolveMove(game.initialState(), {
  row: 4,
  col: 1,
  mirror: "/",
}).state;
assert.equal(productionSearch.isTacticalPosition(commonOpeningState), false);
assert.equal(productionSearch.softTiming(commonOpeningState, 0).softDeadline, 4000);
const openingSafetySearch = new UltraSearch(game, () => 0, {
  timeLimit: Infinity,
  maxDepth: 2,
  rootLimit: 16,
  branchLimits: [22, 14, 10],
});
const openingSafetyMove = openingSafetySearch.choose(commonOpeningState).move;
assert.ok(game.isLegalMove(commonOpeningState, openingSafetyMove));
const openingSafetyState = game.resolveMove(commonOpeningState, openingSafetyMove).state;
assert.equal(openingSafetyState.winner, null);
assert.equal(
  game.legalChildren(openingSafetyState)
    .some(({ state: child }) => child.winner === openingSafetyState.turn),
  false,
);
assert.ok(
  openingSafetySearch.shieldExchange(
    commonOpeningState,
    openingSafetyState,
  ) >= 0,
);
const lateTimingState = game.initialState();
for (const [row, col, mirror] of rootPruningFixture.moves.slice(0, 23)) {
  lateTimingState.board[row - 1][col - 1] = mirror;
}
assert.equal(productionSearch.softTiming(lateTimingState, 0).latePosition, true);

const chokeFixture = JSON.parse(readFileSync(
  new URL("./fixtures/ultra_choke_46_move_log.json", import.meta.url),
));
const chokeGame = new Game();
let chokeState = chokeGame.initialState();
for (const [row, col, mirror] of chokeFixture.moves.slice(0, 40)) {
  chokeState = chokeGame.resolveMove(chokeState, {
    row: row - 1,
    col: col - 1,
    mirror,
  }).state;
}
const tacticalProof = new TacticalProofSearch(chokeGame);
const forcedHumanWin = tacticalProof.prove(chokeState, "bottom", 5);
assert.equal(forcedHumanWin.status, "proven");
assert.equal(forcedHumanWin.distance, 5);
assert.deepEqual(forcedHumanWin.line[0], { row: 2, col: 0, mirror: "/" });

for (const [row, col, mirror] of chokeFixture.moves.slice(40, 44)) {
  chokeState = chokeGame.resolveMove(chokeState, {
    row: row - 1,
    col: col - 1,
    mirror,
  }).state;
}
const mateInOne = tacticalProof.prove(chokeState, "bottom", 1);
assert.equal(mateInOne.status, "proven");
assert.deepEqual(mateInOne.line[0], { row: 5, col: 2, mirror: "\\" });

const [blunderRow, blunderCol, blunderMirror] = chokeFixture.moves[44];
chokeState = chokeGame.resolveMove(chokeState, {
  row: blunderRow - 1,
  col: blunderCol - 1,
  mirror: blunderMirror,
}).state;
const ultraMate = tacticalProof.prove(chokeState, "top", 1);
assert.equal(ultraMate.status, "proven");
assert.deepEqual(ultraMate.line[0], { row: 7, col: 8, mirror: "/" });

const swapKing = (cell) => (cell === "k" ? "K" : cell === "K" ? "k" : cell);
const invertedMateState = {
  board: [...chokeState.board].reverse().map(
    (row) => [...row].reverse().map(swapKing),
  ),
  turn: "bottom",
  winner: null,
  draw: false,
};
const invertedMateMove = { row: 1, col: 0, mirror: "/" };
assert.equal(
  game.resolveMove(invertedMateState, invertedMateMove).state.winner,
  "bottom",
);
const invertedMateSearch = new UltraSearch(game, () => 0, TEST_PROFILE);
assert.deepEqual(invertedMateSearch.choose(invertedMateState).move, invertedMateMove);

const slowFixture = JSON.parse(readFileSync(
  new URL("./fixtures/ultra_slow_14_move_log.json", import.meta.url),
));
const persistentGame = new Game();
const persistentSearch = new UltraSearch(persistentGame, () => 0, {
  ...TEST_PROFILE,
  maxDepth: 3,
  rootLimit: 16,
  branchLimits: [22, 14, 10],
});
let persistentState = persistentGame.initialState();
for (let index = 0; index < slowFixture.moves.length - 1; index += 1) {
  if (index % 2 === 1) persistentSearch.choose(persistentState);
  const [row, col, mirror] = slowFixture.moves[index];
  persistentState = persistentGame.resolveMove(persistentState, {
    row: row - 1,
    col: col - 1,
    mirror,
  }, false, false).state;
}
const persistentResult = persistentSearch.choose(persistentState);
const [expectedRow, expectedCol, expectedMirror] = slowFixture.expectedMoveBeforePly14;
assert.deepEqual(
  persistentResult.move,
  { row: expectedRow - 1, col: expectedCol - 1, mirror: expectedMirror },
  "Earlier Ultra turns must not hide the forcing move at ply 14.",
);
assert.ok(
  persistentResult.score >= 9_900,
  `Ultra should prove the forcing line, not settle for ${persistentResult.score}.`,
);

const assignmentFixture = JSON.parse(readFileSync(
  new URL("./fixtures/ultra_loss_26_move_log.json", import.meta.url),
));
const assignmentGame = new Game();
let assignmentState = assignmentGame.initialState();
for (const [row, col, mirror] of assignmentFixture.moves.slice(0, 15)) {
  assignmentState = assignmentGame.resolveMove(assignmentState, {
    row: row - 1,
    col: col - 1,
    mirror,
  }).state;
}
const assignmentSearch = new UltraSearch(assignmentGame, () => 0, {
  ...TEST_PROFILE,
  maxDepth: 4,
  rootLimit: 16,
  branchLimits: [22, 14, 10],
});
const reportedBlunder = { row: 2, col: 2, mirror: "\\" };
const blunderState = assignmentGame.resolveMove(assignmentState, reportedBlunder).state;
assert.equal(
  assignmentSearch.opponentCanClaimDedicatedLaser(blunderState),
  true,
  "The reported move must expose a permanent one-laser assignment lock.",
);
const exactThreatSearch = new UltraSearch(assignmentGame, () => 0, TEST_PROFILE);
let exactThreatChecks = 0;
exactThreatSearch.strictChild = (_parent, _move, child, allowExact = true) => {
  if (!allowExact) return null;
  exactThreatChecks += 1;
  return child;
};
assert.equal(
  exactThreatSearch.opponentCanClaimDedicatedLaser(blunderState),
  true,
  "A concrete assignment threat must fall back to exact legality.",
);
assert.ok(exactThreatChecks > 0);
const assignmentResult = assignmentSearch.choose(assignmentState);
const assignmentChild = assignmentGame.resolveMove(assignmentState, assignmentResult.move).state;
assert.equal(
  assignmentSearch.opponentCanClaimDedicatedLaser(assignmentChild),
  false,
  "Ultra must reject an avoidable permanent assignment lock.",
);
assert.notDeepEqual(assignmentResult.move, reportedBlunder);

const exactFallbackGame = new Game();
exactFallbackGame.jointPathPreservedFast = () => false;
const exactFallbackSearch = new UltraSearch(exactFallbackGame, () => 0, {
  ...TEST_PROFILE,
  maxDepth: 1,
  rootLimit: 4,
});
exactFallbackSearch.opponentCanClaimDedicatedLaser = () => false;
const exactFallbackState = exactFallbackGame.initialState();
const exactFallbackResult = exactFallbackSearch.choose(exactFallbackState);
assert.ok(
  exactFallbackResult.move
    && exactFallbackGame.isLegalMove(exactFallbackState, exactFallbackResult.move),
  "Ultra must retain an exact legal fallback when bounded witnesses find no move.",
);

console.log(
  `Ultra horizon check passed at depth ${result.depth} `
  + `(${result.nodes.toLocaleString()} positions, ${Math.round(result.elapsed)} ms).`,
);
