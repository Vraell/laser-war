import assert from "node:assert/strict";

import {
  pairedBootstrapInterval,
  pairedScoreRate,
  passesArenaGate,
  pentanomialCounts,
  summarizePairs,
} from "./arena_stats.mjs";

assert.equal(pairedScoreRate([2, 1, 0]), 0.5);
assert.deepEqual(pentanomialCounts([0, 0.5, 1, 1.5, 2]), [1, 1, 1, 1, 1]);
assert.throws(() => pentanomialCounts([0.25]), /Invalid paired score/);

const dominant = summarizePairs(Array(24).fill(2), { samples: 1000 });
assert.equal(dominant.scoreRate, 1);
assert.equal(dominant.low, 1);
assert.equal(dominant.high, 1);

const balanced = Array.from({ length: 48 }, (_, index) => index % 2 ? 0 : 2);
const interval = pairedBootstrapInterval(balanced, { samples: 5000, seed: 7 });
assert.ok(interval[0] < 0.5);
assert.ok(interval[1] > 0.5);
assert.equal(passesArenaGate({ scoreRate: 0.5, low: 0.43, high: 0.57 }, "nonregression"), true);
assert.equal(passesArenaGate({ scoreRate: 0.44, low: 0.36, high: 0.52 }, "nonregression"), false);
assert.equal(passesArenaGate({ scoreRate: 0.46, low: 0.41, high: 0.49 }, "nonregression"), false);
assert.equal(passesArenaGate({ scoreRate: 0.58, low: 0.51, high: 0.64 }, "improvement"), true);
assert.equal(passesArenaGate({ scoreRate: 0.58, low: 0.49, high: 0.66 }, "improvement"), false);

console.log("Arena statistics checks passed.");
