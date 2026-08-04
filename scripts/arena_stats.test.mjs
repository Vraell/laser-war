import assert from "node:assert/strict";

import {
  pairedBootstrapInterval,
  pairedScoreRate,
  passesArenaGate,
  pentanomialSprt,
  pentanomialCounts,
  scoreRateFromElo,
  summarizePairs,
} from "./arena_stats.mjs";

assert.equal(pairedScoreRate([2, 1, 0]), 0.5);
assert.deepEqual(pentanomialCounts([0, 0.5, 1, 1.5, 2]), [1, 1, 1, 1, 1]);
assert.throws(() => pentanomialCounts([0.25]), /Invalid paired score/);
assert.equal(scoreRateFromElo(0), 0.5);
assert.ok(scoreRateFromElo(20) > 0.5);

const dominant = summarizePairs(Array(24).fill(2), { samples: 1000 });
assert.equal(dominant.scoreRate, 1);
assert.equal(dominant.low, 1);
assert.equal(dominant.high, 1);

const balanced = Array.from({ length: 48 }, (_, index) => index % 2 ? 0 : 2);
const interval = pairedBootstrapInterval(balanced, { samples: 5000, seed: 7 });
assert.ok(interval[0] < 0.5);
assert.ok(interval[1] > 0.5);
const nonRegressionEvidence = summarizePairs(Array(512).fill(1));
assert.equal(nonRegressionEvidence.nonregressionSprt.status, "accept-h1");
assert.equal(passesArenaGate(nonRegressionEvidence, "nonregression"), true);
const fixedCiNeutral = summarizePairs(Array(64).fill(1));
assert.equal(
  passesArenaGate(fixedCiNeutral, "nonregression"),
  true,
  "The configured fixed-size release gate must pass an identical engine.",
);
const regressionEvidence = summarizePairs(Array(512).fill(0.5));
assert.equal(regressionEvidence.nonregressionSprt.status, "accept-h0");
assert.equal(passesArenaGate(regressionEvidence, "nonregression"), false);
const improvementEvidence = summarizePairs(Array(512).fill(1.5));
assert.equal(improvementEvidence.improvementSprt.status, "accept-h1");
assert.equal(passesArenaGate(improvementEvidence, "improvement"), true);
assert.equal(
  passesArenaGate({ low: 0.49 }, "improvement"),
  false,
);
assert.equal(
  pentanomialSprt(Array(32).fill(1), { elo0: -20, elo1: 0 }).status,
  "inconclusive",
);

console.log("Arena statistics checks passed.");
