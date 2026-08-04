import assert from "node:assert/strict";

import {
  generatedAdversarialCases,
  historicalTacticalCases,
} from "../experiments/eval_tactical_graph_cases.mjs";
import {
  buildShieldDependencyGraph,
  tacticalGraphEvaluation,
} from "../experiments/eval_tactical_graph_model.mjs";

/** Evaluate a resolved move from the player who selected it. */
function moveScore(tacticalCase, item, proofPlies = 1) {
  return tacticalGraphEvaluation(
    tacticalCase.game,
    item.state,
    tacticalCase.state.turn,
    { proofPlies, proofMaxNodes: 2_000 },
  ).score;
}

const historical = historicalTacticalCases();
assert.equal(historical.length, 4);
assert.deepEqual(
  historical.map(({ preferred, blunders }) => [preferred.length, blunders.length]),
  [[8, 102], [1, 98], [2, 38], [91, 8]],
  "Independent fixture labels must remain stable under the exact rules engine.",
);

for (const tacticalCase of historical.slice(0, 3)) {
  assert.ok(tacticalCase.knownDefense);
  assert.ok(tacticalCase.reportedBlunder);
  assert.ok(
    moveScore(tacticalCase, tacticalCase.knownDefense)
      > moveScore(tacticalCase, tacticalCase.reportedBlunder),
    `${tacticalCase.name}: the known defense must outrank the reported blunder.`,
  );
}

const generated = generatedAdversarialCases(historical);
assert.equal(generated.openButHarmless.profile.routes.nearestAttack, 1);
assert.equal(generated.openButHarmless.profile.immediateWins, 0);
assert.equal(generated.openButHarmless.profile.loadedThreats, 0);
assert.ok(generated.enforceableRoute.profile.routes.nearestAttack <= 1);
assert.equal(generated.enforceableRoute.profile.certificate.status, "proven");

const openScore = tacticalGraphEvaluation(
  generated.openButHarmless.game,
  generated.openButHarmless.state,
  generated.openButHarmless.attacker,
  { proofPlies: 3, proofMaxNodes: 3_000 },
).score;
const enforceableScore = tacticalGraphEvaluation(
  generated.enforceableRoute.game,
  generated.enforceableRoute.state,
  generated.enforceableRoute.attacker,
  { proofPlies: 1, proofMaxNodes: 1_000 },
).score;
assert.ok(
  enforceableScore > openScore + 5_000,
  "An enforceable attack must score far above a visually open but harmless route.",
);

assert.deepEqual(generated.splitAssignment.masks, [1, 2]);
const splitTop = tacticalGraphEvaluation(
  generated.splitAssignment.game,
  generated.splitAssignment.state,
  "top",
  { proofPlies: 0 },
).score;
const splitBottom = tacticalGraphEvaluation(
  generated.splitAssignment.game,
  generated.splitAssignment.state,
  "bottom",
  { proofPlies: 0 },
).score;
assert.ok(Number.isFinite(splitTop));
assert.equal(splitTop, -splitBottom, "Split laser assignment must remain color-antisymmetric.");

assert.equal(generated.cascadeDecoy.profile.cascade.kingChains, 1);
assert.ok(generated.cascadeDecoy.profile.bestDefensiveMoves >= 3);
assert.notEqual(generated.cascadeDecoy.profile.certificate.status, "proven");
const graph = buildShieldDependencyGraph(
  generated.cascadeDecoy.game,
  generated.cascadeDecoy.state.board,
);
for (const chain of graph.chains) {
  const shields = chain
    .filter(({ type }) => type === "shield")
    .map(({ square }) => `${square[0]},${square[1]}`);
  assert.equal(new Set(shields).size, shields.length, "A cascade cannot remove one shield twice.");
}

const trap = generated.routeRankingTrap;
assert.ok(trap.geometryGap >= 0, "The generated trap must fool route-only ordering.");
const trapDefense = tacticalGraphEvaluation(
  trap.game,
  trap.defense.state,
  trap.perspective,
  { proofPlies: 1, proofMaxNodes: 1_000 },
).score;
const trapBlunder = tacticalGraphEvaluation(
  trap.game,
  trap.blunder.state,
  trap.perspective,
  { proofPlies: 1, proofMaxNodes: 1_000 },
).score;
assert.ok(trapDefense > trapBlunder, "The graph evaluator must repair the route-only inversion.");

console.log("Tactical graph evaluation invariants passed.");
