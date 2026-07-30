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
  };
}

/** Apply the arena's practical non-regression or statistical improvement rule. */
export function passesArenaGate(summary, gate) {
  if (gate === "off") return true;
  if (gate === "nonregression") {
    return summary.scoreRate >= 0.45 && summary.high >= 0.5;
  }
  if (gate === "improvement") return summary.low > 0.5;
  throw new Error(`Unknown arena gate: ${gate}`);
}
