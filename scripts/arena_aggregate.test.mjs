import assert from "node:assert/strict";

import { aggregateArenaReports } from "./aggregate_arena.mjs";

/** Build a minimal valid shard for aggregation contract tests. */
function shard(offset, scores, openingPrefix = "opening") {
  const hashes = {
    candidate: "candidate",
    baseline: "baseline",
    candidateRules: "rules",
    baselineRules: "rules",
    openingBook: "book",
  };
  return {
    schema: "laser-war-arena-v3",
    harnessHash: "123456789abc",
    options: {
      openings: "mixed",
      difficulties: ["ultra"],
      pairOffset: offset,
      pairs: scores.length,
      gate: "off",
      maxPlies: 96,
      resource: "nodes",
      ultraNodes: 20000,
      seedOffset: 0,
      openingPlies: [0, 2],
      candidateRef: "HEAD",
      baselineRef: "HEAD^",
    },
    qualification: [{
      difficulty: "ultra",
      pairScores: scores,
      invalid: [],
      forfeits: [],
      sourceHashes: hashes,
      openingIds: scores.map((_, index) => `${openingPrefix}-${offset + index}`),
    }],
  };
}

const options = {
  openings: "mixed",
  difficulty: "ultra",
  expectedPairs: 4,
  gate: "nonregression",
  expectedShards: 2,
  maxPlies: 96,
  resource: "nodes",
  ultraNodes: 20000,
  seedOffset: 0,
  openingPlies: [0, 2],
  candidateRef: "HEAD",
  baselineRef: "HEAD^",
};
const aggregate = aggregateArenaReports([
  shard(2, [1, 1]),
  shard(0, [1, 1]),
], options);
assert.equal(aggregate.pairCount, 4);
assert.equal(aggregate.shardCount, 2);
assert.equal(aggregate.result.scoreRate, 0.5);

assert.throws(
  () => aggregateArenaReports([shard(0, [1]), shard(2, [1, 1])], options),
  /coverage expected pair 1, found 2/,
);
assert.throws(
  () => aggregateArenaReports([shard(0, [1, 1]), shard(2, [1, 1], "opening")], {
    ...options,
    expectedPairs: 5,
  }),
  /covered 4 pairs; expected 5/,
);
assert.throws(
  () => aggregateArenaReports([shard(0, [1, 1]), shard(2, [1, 1], "opening-2")], {
    ...options,
    gate: "improvement",
  }),
  /failed the improvement aggregate gate/,
);

const invalid = shard(0, [1, 1]);
invalid.qualification[0].invalid.push({ reason: "timeout" });
assert.throws(
  () => aggregateArenaReports([invalid, shard(2, [1, 1])], options),
  /invalid candidate games/,
);

const wrongBudget = shard(2, [1, 1]);
wrongBudget.options.ultraNodes = 500;
assert.throws(
  () => aggregateArenaReports([shard(0, [1, 1]), wrongBudget], options),
  /incompatible qualification settings/,
);

const wrongHarness = shard(2, [1, 1]);
wrongHarness.harnessHash = "abcdef123456";
assert.throws(
  () => aggregateArenaReports([shard(0, [1, 1]), wrongHarness], options),
  /different harnesses/,
);

console.log("Arena shard aggregation checks passed.");
