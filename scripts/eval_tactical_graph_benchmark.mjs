import {
  generatedAdversarialCases,
  generatedCaseSummary,
  historicalTacticalCases,
} from "../experiments/eval_tactical_graph_cases.mjs";
import {
  TACTICAL_GRAPH_FAMILIES,
  routeOnlyEvaluation,
  tacticalGraphEvaluation,
  tacticalMoveLabel,
} from "../experiments/eval_tactical_graph_model.mjs";

/** Return the percentile of preferred-versus-blunder pairs ordered correctly. */
function pairwiseAccuracy(ranked, preferredMoves, blunderMoves, scoreOf) {
  const preferred = ranked.filter(({ item }) => preferredMoves.has(item.move)).map(scoreOf);
  const blunders = ranked.filter(({ item }) => blunderMoves.has(item.move)).map(scoreOf);
  let correct = 0;
  let comparisons = 0;
  for (const good of preferred) {
    for (const bad of blunders) {
      comparisons += 1;
      if (good > bad) correct += 1;
      else if (good === bad) correct += 0.5;
    }
  }
  return comparisons ? correct / comparisons : 0;
}

/** Rank every legal move once and retain independently ablatable components. */
function rankCase(tacticalCase) {
  const perspective = tacticalCase.state.turn;
  const samples = [];
  const ranked = tacticalCase.children.map((item) => {
    const started = performance.now();
    const evaluation = tacticalGraphEvaluation(
      tacticalCase.game,
      item.state,
      perspective,
      { proofPlies: 1, proofMaxNodes: 1_000 },
    );
    samples.push(performance.now() - started);
    return {
      item,
      score: evaluation.score,
      components: evaluation.components,
      routeOnly: routeOnlyEvaluation(tacticalCase.game, item.state, perspective),
    };
  }).sort((left, right) => right.score - left.score
    || tacticalMoveLabel(left.item.move).localeCompare(tacticalMoveLabel(right.item.move)));
  const preferredMoves = new Set(tacticalCase.preferred.map(({ move }) => move));
  const blunderMoves = new Set(tacticalCase.blunders.map(({ move }) => move));
  const rankOf = (candidate) => candidate
    ? ranked.findIndex(({ item }) => item.move === candidate.move) + 1
    : null;
  const bestPreferredRank = ranked.findIndex(({ item }) => preferredMoves.has(item.move)) + 1;
  const fullAccuracy = pairwiseAccuracy(ranked, preferredMoves, blunderMoves, ({ score }) => score);
  const routeAccuracy = pairwiseAccuracy(ranked, preferredMoves, blunderMoves, ({ routeOnly }) => routeOnly);
  const ablations = Object.fromEntries(TACTICAL_GRAPH_FAMILIES.map((family) => [
    family,
    pairwiseAccuracy(
      ranked,
      preferredMoves,
      blunderMoves,
      ({ score, components }) => score - components[family],
    ),
  ]));
  return {
    name: tacticalCase.name,
    partition: tacticalCase.partition,
    legalMoves: ranked.length,
    preferredMoves: tacticalCase.preferred.length,
    blunders: tacticalCase.blunders.length,
    bestPreferredRank,
    knownDefenseRank: rankOf(tacticalCase.knownDefense),
    reportedBlunderRank: rankOf(tacticalCase.reportedBlunder),
    fullAccuracy,
    routeAccuracy,
    ablations,
    ranked,
    samples,
  };
}

/** Return median and tail latency without assuming a normal distribution. */
function latencySummary(samples) {
  const sorted = [...samples].sort((a, b) => a - b);
  const quantile = (fraction) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))];
  return {
    samples: sorted.length,
    medianMs: quantile(0.5),
    p95Ms: quantile(0.95),
    maxMs: sorted.at(-1),
  };
}

/** Calculate an unweighted mean across independently labelled fixture cases. */
function mean(rows, selector) {
  return rows.reduce((total, row) => total + selector(row), 0) / rows.length;
}

/** Summarize one fixture partition without leaking development labels into holdout metrics. */
function partitionSummary(rows) {
  return {
    cases: rows.length,
    legalMovesRanked: rows.reduce((total, row) => total + row.legalMoves, 0),
    topMoveSuccesses: rows.filter(({ bestPreferredRank }) => bestPreferredRank === 1).length,
    meanPairwiseAccuracy: mean(rows, ({ fullAccuracy }) => fullAccuracy),
    routeOnlyPairwiseAccuracy: mean(rows, ({ routeAccuracy }) => routeAccuracy),
    ablationPairwiseAccuracy: Object.fromEntries(TACTICAL_GRAPH_FAMILIES.map((family) => [
      family,
      mean(rows, (row) => row.ablations[family]),
    ])),
  };
}

const started = performance.now();
const historical = historicalTacticalCases();
const generated = generatedAdversarialCases(historical);
const rankings = historical.map(rankCase);
const latency = latencySummary(rankings.flatMap(({ samples }) => samples));
const ablations = Object.fromEntries(TACTICAL_GRAPH_FAMILIES.map((family) => [
  family,
  mean(rankings, (row) => row.ablations[family]),
]));
const openEvaluation = tacticalGraphEvaluation(
  generated.openButHarmless.game,
  generated.openButHarmless.state,
  generated.openButHarmless.attacker,
  { proofPlies: 3, proofMaxNodes: 3_000 },
);
const enforceableEvaluation = tacticalGraphEvaluation(
  generated.enforceableRoute.game,
  generated.enforceableRoute.state,
  generated.enforceableRoute.attacker,
  { proofPlies: 1, proofMaxNodes: 1_000 },
);
const splitTop = tacticalGraphEvaluation(
  generated.splitAssignment.game,
  generated.splitAssignment.state,
  "top",
  { proofPlies: 0 },
);
const splitBottom = tacticalGraphEvaluation(
  generated.splitAssignment.game,
  generated.splitAssignment.state,
  "bottom",
  { proofPlies: 0 },
);

const result = {
  format: 1,
  historical: rankings.map((row) => ({
    name: row.name,
    partition: row.partition,
    legalMoves: row.legalMoves,
    preferredMoves: row.preferredMoves,
    blunders: row.blunders,
    bestPreferredRank: row.bestPreferredRank,
    knownDefenseRank: row.knownDefenseRank,
    reportedBlunderRank: row.reportedBlunderRank,
    pairwiseAccuracy: row.fullAccuracy,
    routeOnlyAccuracy: row.routeAccuracy,
    topThree: row.ranked.slice(0, 3).map(({ item, score }) => ({
      move: tacticalMoveLabel(item.move),
      score,
    })),
  })),
  aggregate: {
    cases: rankings.length,
    legalMovesRanked: rankings.reduce((total, row) => total + row.legalMoves, 0),
    topMoveSuccesses: rankings.filter(({ bestPreferredRank }) => bestPreferredRank === 1).length,
    meanPairwiseAccuracy: mean(rankings, ({ fullAccuracy }) => fullAccuracy),
    routeOnlyPairwiseAccuracy: mean(rankings, ({ routeAccuracy }) => routeAccuracy),
    ablationPairwiseAccuracy: ablations,
    development: partitionSummary(rankings.filter(({ partition }) => partition === "development")),
    heldOut: partitionSummary(rankings.filter(({ partition }) => partition === "held-out")),
  },
  adversarial: {
    provenance: Object.fromEntries(Object.entries(generated).map(([name, item]) => [
      name,
      generatedCaseSummary(item),
    ])),
    openButHarmless: {
      nearestRoute: generated.openButHarmless.profile.routes.nearestAttack,
      immediateWins: generated.openButHarmless.profile.immediateWins,
      loadedThreats: generated.openButHarmless.profile.loadedThreats,
      score: openEvaluation.score,
      routeOnlyScore: routeOnlyEvaluation(
        generated.openButHarmless.game,
        generated.openButHarmless.state,
        generated.openButHarmless.attacker,
      ),
    },
    enforceableRoute: {
      nearestRoute: generated.enforceableRoute.profile.routes.nearestAttack,
      immediateWins: generated.enforceableRoute.profile.immediateWins,
      certificate: generated.enforceableRoute.profile.certificate.status,
      score: enforceableEvaluation.score,
      routeOnlyScore: routeOnlyEvaluation(
        generated.enforceableRoute.game,
        generated.enforceableRoute.state,
        generated.enforceableRoute.attacker,
      ),
    },
    cascadeDecoy: {
      kingChains: generated.cascadeDecoy.profile.cascade.kingChains,
      defensiveMoves: generated.cascadeDecoy.profile.bestDefensiveMoves,
      certificate: generated.cascadeDecoy.profile.certificate.status,
    },
    splitAssignment: {
      masks: generated.splitAssignment.masks,
      topScore: splitTop.score,
      bottomScore: splitBottom.score,
      antisymmetryError: Math.abs(splitTop.score + splitBottom.score),
    },
    routeRankingTrap: {
      source: generated.routeRankingTrap.name,
      defense: tacticalMoveLabel(generated.routeRankingTrap.defense.move),
      blunder: tacticalMoveLabel(generated.routeRankingTrap.blunder.move),
      routeOnlyBlunderAdvantage: generated.routeRankingTrap.geometryGap,
    },
  },
  runtime: {
    evaluation: latency,
    endToEndMs: performance.now() - started,
  },
};

console.log(JSON.stringify(result, null, 2));
