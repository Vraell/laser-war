import { pentanomialSprt } from "../../scripts/arena_stats.mjs";

const TRIALS = 5000;

/** Return a deterministic pseudo-random source for repeatable audit simulations. */
function randomSource(initialSeed) {
  let seed = initialSeed >>> 0;
  return () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 2 ** 32;
  };
}

/** Convert logistic Elo into expected game score without draws. */
function scoreRateFromElo(elo) {
  return 1 / (1 + (10 ** (-elo / 400)));
}

/** Estimate accept/reject/inconclusive rates for the current non-regression SPRT. */
function estimatedStatuses(elo, pairs) {
  const random = randomSource(0xa11ce ^ (elo + 1000) ^ pairs);
  const scoreRate = scoreRateFromElo(elo);
  const counts = { "accept-h1": 0, "accept-h0": 0, inconclusive: 0 };
  for (let trial = 0; trial < TRIALS; trial += 1) {
    const pairScores = [];
    for (let pair = 0; pair < pairs; pair += 1) {
      pairScores.push(
        Number(random() < scoreRate) + Number(random() < scoreRate),
      );
    }
    const { status } = pentanomialSprt(pairScores, { elo0: -20, elo1: 0 });
    counts[status] += 1;
  }
  return Object.fromEntries(Object.entries(counts).map(
    ([status, count]) => [status, `${(count * 100 / TRIALS).toFixed(1)}%`],
  ));
}

console.log(`Current non-regression SPRT, ${TRIALS} no-draw simulations per cell:`);
for (const pairs of [64, 128, 256, 512]) {
  for (const elo of [-20, -10, 0, 10, 20]) {
    console.log(JSON.stringify({ pairs, elo, ...estimatedStatuses(elo, pairs) }));
  }
}

console.log("Exact neutral paired scores:");
for (const pairs of [32, 64, 65, 96, 128]) {
  const result = pentanomialSprt(Array(pairs).fill(1), { elo0: -20, elo1: 0 });
  console.log(JSON.stringify({ pairs, status: result.status, llr: result.llr, upper: result.upper }));
}
