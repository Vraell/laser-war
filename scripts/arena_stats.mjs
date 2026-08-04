/** Convert a score rate to conventional logistic Elo. */
export function eloFromScore(scoreRate) {
  const bounded = Math.min(0.999, Math.max(0.001, scoreRate));
  return 400 * Math.log10(bounded / (1 - bounded));
}

/** Return the mean candidate score per game from paired two-game scores. */
export function pairedScoreRate(pairScores) {
  if (!pairScores.length) return 0.5;
  return pairScores.reduce((total, score) => total + score, 0) / (pairScores.length * 2);
}

/** Classify paired results using Fishtest's five-outcome representation. */
export function pentanomialCounts(pairScores) {
  const counts = [0, 0, 0, 0, 0];
  for (const score of pairScores) {
    if (![0, 0.5, 1, 1.5, 2].includes(score)) {
      throw new Error(`Invalid paired score: ${score}`);
    }
    counts[Math.round(score * 2)] += 1;
  }
  return counts;
}

/** Convert conventional logistic Elo into an expected per-game score. */
export function scoreRateFromElo(elo) {
  return 1 / (1 + (10 ** (-elo / 400)));
}

/** Exponentially tilt an empirical pentanomial distribution to a target score. */
function tiltedDistribution(counts, targetScore) {
  const outcomes = [0, 0.25, 0.5, 0.75, 1];
  const total = counts.reduce((sum, count) => sum + count, 0);
  const base = counts.map((count) => (count + 0.5) / (total + 2.5));
  let low = -40;
  let high = 40;
  for (let iteration = 0; iteration < 100; iteration += 1) {
    const lambda = (low + high) / 2;
    const weighted = base.map((probability, index) => (
      probability * Math.exp(lambda * outcomes[index])
    ));
    const normalizer = weighted.reduce((sum, value) => sum + value, 0);
    const mean = weighted.reduce(
      (sum, value, index) => sum + value * outcomes[index],
      0,
    ) / normalizer;
    if (mean < targetScore) low = lambda;
    else high = lambda;
  }
  const lambda = (low + high) / 2;
  const weighted = base.map((probability, index) => (
    probability * Math.exp(lambda * outcomes[index])
  ));
  const normalizer = weighted.reduce((sum, value) => sum + value, 0);
  return weighted.map((value) => value / normalizer);
}

/** Evaluate a pentanomial SPRT between two predeclared Elo hypotheses. */
export function pentanomialSprt(pairScores, {
  elo0,
  elo1,
  alpha = 0.05,
  beta = 0.05,
} = {}) {
  if (!(elo1 > elo0)) throw new Error("SPRT requires elo1 > elo0.");
  const counts = pentanomialCounts(pairScores);
  const hypothesis0 = tiltedDistribution(counts, scoreRateFromElo(elo0));
  const hypothesis1 = tiltedDistribution(counts, scoreRateFromElo(elo1));
  const llr = counts.reduce(
    (sum, count, index) => sum + count * Math.log(hypothesis1[index] / hypothesis0[index]),
    0,
  );
  const lower = Math.log(beta / (1 - alpha));
  const upper = Math.log((1 - beta) / alpha);
  const status = llr >= upper ? "accept-h1" : llr <= lower ? "accept-h0" : "inconclusive";
  return { elo0, elo1, alpha, beta, llr, lower, upper, status };
}

/** Produce a deterministic percentile bootstrap interval over opening pairs. */
export function pairedBootstrapInterval(pairScores, {
  samples = 10000,
  confidence = 0.95,
  seed = 0x51a7f15,
} = {}) {
  if (!pairScores.length) return [0, 1];
  let state = seed >>> 0;
  const random = () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
  const estimates = new Float64Array(samples);
  for (let sample = 0; sample < samples; sample += 1) {
    let score = 0;
    for (let index = 0; index < pairScores.length; index += 1) {
      score += pairScores[Math.floor(random() * pairScores.length)];
    }
    estimates[sample] = score / (pairScores.length * 2);
  }
  estimates.sort();
  const tail = (1 - confidence) / 2;
  const lowIndex = Math.max(0, Math.floor(tail * samples));
  const highIndex = Math.min(samples - 1, Math.ceil((1 - tail) * samples) - 1);
  return [estimates[lowIndex], estimates[highIndex]];
}

/** Summarize paired results with score, Elo, uncertainty, and pentanomial counts. */
export function summarizePairs(pairScores, bootstrapOptions) {
  const scoreRate = pairedScoreRate(pairScores);
  const [low, high] = pairedBootstrapInterval(pairScores, bootstrapOptions);
  return {
    pairs: pairScores.length,
    games: pairScores.length * 2,
    scoreRate,
    elo: eloFromScore(scoreRate),
    low,
    high,
    lowElo: eloFromScore(low),
    highElo: eloFromScore(high),
    pentanomial: pentanomialCounts(pairScores),
    nonregressionSprt: pentanomialSprt(pairScores, { elo0: -20, elo1: 0 }),
    improvementSprt: pentanomialSprt(pairScores, { elo0: 0, elo1: 20 }),
  };
}

/** Apply the arena's practical non-regression or statistical improvement rule. */
export function passesArenaGate(summary, gate) {
  if (gate === "off") return true;
  if (gate === "nonregression") {
    // Fixed-size CI batches are not sequential tests. Require a neutral point
    // estimate and reject confidence intervals compatible with a severe loss.
    return summary.scoreRate >= 0.49 && summary.low >= 0.45;
  }
  if (gate === "improvement") return summary.low > 0.5;
  throw new Error(`Unknown arena gate: ${gate}`);
}
