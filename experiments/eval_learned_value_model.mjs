import { EVALUATION_WEIGHTS, routePressureScore } from "../web/ai.js";
import { Cell } from "../web/engine.js";

export const FEATURE_NAMES = Object.freeze([
  "shieldBalance",
  "attackTempo",
  "reserveTempo",
  "dedicatedLaserBalance",
  "oneMoveRouteBalance",
  "liveKingBalance",
  "cascadeKingBalance",
  "liveShieldBalance",
]);

export const FEATURE_FAMILIES = Object.freeze({
  shields: ["shieldBalance"],
  routes: ["attackTempo", "reserveTempo", "oneMoveRouteBalance"],
  assignment: ["dedicatedLaserBalance"],
  exposure: ["liveKingBalance"],
  cascade: ["cascadeKingBalance"],
  contact: ["liveShieldBalance"],
});

export const MONOTONIC_CONSTRAINTS = Object.freeze(
  Object.fromEntries(FEATURE_NAMES.map((name) => [name, "positive"])),
);

const TOP_SHIELDS = new Set(["0,3", "0,5", "1,3", "1,4", "1,5", "2,4"]);
const BOTTOM_SHIELDS = new Set(["8,3", "8,5", "7,3", "7,4", "7,5", "6,4"]);
const ROUTE_LIMIT = EVALUATION_WEIGHTS.routeLimit;

/** Return a deterministic random stream suitable for generation and bootstrap sampling. */
export function randomSource(initialSeed) {
  let seed = initialSeed >>> 0;
  return () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 2 ** 32;
  };
}

/** Clamp a possibly absent route to the evaluator's finite planning horizon. */
function boundedRoute(costs, player) {
  return Math.min(costs[player] ?? ROUTE_LIMIT, ROUTE_LIMIT);
}

/** Identify the king enclosure that owns one fixed shield square. */
function shieldOwner(square) {
  if (!square) return null;
  const key = `${square[0]},${square[1]}`;
  if (TOP_SHIELDS.has(key)) return "top";
  if (BOTTOM_SHIELDS.has(key)) return "bottom";
  return null;
}

/** Count surviving shields in each fixed king enclosure. */
function shieldCounts(board) {
  let top = 0;
  let bottom = 0;
  for (let row = 0; row < board.length; row += 1) {
    for (let col = 0; col < board[row].length; col += 1) {
      if (board[row][col] !== Cell.SHIELD) continue;
      if (TOP_SHIELDS.has(`${row},${col}`)) top += 1;
      if (BOTTOM_SHIELDS.has(`${row},${col}`)) bottom += 1;
    }
  }
  return { top, bottom };
}

/** Convert beam contacts into signed king and shield pressure for one perspective. */
function beamPressure(beams, own, opponent) {
  let king = 0;
  let shield = 0;
  for (const beam of beams) {
    if (beam.hitKing === opponent) king += 1;
    else if (beam.hitKing === own) king -= 1;
    const owner = shieldOwner(beam.hitShield);
    if (owner === opponent) shield += 1;
    else if (owner === own) shield -= 1;
  }
  return { king, shield };
}

/** Extract eight signed, interpretable features from the side-to-move perspective. */
export function extractFeatures(game, state) {
  const own = state.turn;
  const opponent = own === "top" ? "bottom" : "top";
  const ownMask = own === "top" ? 1 : 2;
  const opponentMask = opponent === "top" ? 1 : 2;
  const shields = shieldCounts(state.board);
  const masks = game.reachableKingMasksByLaser(state.board);
  const dedicatedLaserBalance = masks.reduce((total, mask) => (
    total + Number(mask === opponentMask) - Number(mask === ownMask)
  ), 0);

  const routeCosts = game.routeCostsByLaser(state.board);
  const attacks = routeCosts.map((costs) => boundedRoute(costs, opponent)).sort((a, b) => a - b);
  const dangers = routeCosts.map((costs) => boundedRoute(costs, own)).sort((a, b) => a - b);
  const attackTempo = dangers[0] - attacks[0];
  const reserveTempo = dangers[1] - attacks[1];
  const oneMoveRouteBalance = attacks.filter((cost) => cost <= 1).length
    - dangers.filter((cost) => cost <= 1).length;

  const beams = game.fireLasers(state.board);
  const live = beamPressure(beams, own, opponent);
  const cascadeBoard = state.board.map((row) => [...row]);
  let destroyed = false;
  for (const beam of beams) {
    if (!beam.hitShield) continue;
    cascadeBoard[beam.hitShield[0]][beam.hitShield[1]] = Cell.EMPTY;
    destroyed = true;
  }
  const cascade = destroyed
    ? beamPressure(game.fireLasers(cascadeBoard), own, opponent)
    : live;

  return {
    shieldBalance: shields[own] - shields[opponent],
    attackTempo,
    reserveTempo,
    dedicatedLaserBalance,
    oneMoveRouteBalance,
    liveKingBalance: live.king,
    cascadeKingBalance: cascade.king - live.king,
    liveShieldBalance: live.shield,
  };
}

/** Reconstruct the incumbent strategic score from the same state. */
export function incumbentScore(game, state, features = extractFeatures(game, state)) {
  const own = state.turn;
  const opponent = own === "top" ? "bottom" : "top";
  return features.shieldBalance * EVALUATION_WEIGHTS.shieldCount
    + features.dedicatedLaserBalance * EVALUATION_WEIGHTS.assignment
    + routePressureScore(game.routeCostsByLaser(state.board), own, opponent)
    + features.liveKingBalance * EVALUATION_WEIGHTS.exposure;
}

/** Rotate the arena 180 degrees while swapping red/blue identities. */
export function rotateAndSwapState(state) {
  const swapCell = (cell) => {
    if (cell === Cell.TOP_KING) return Cell.BOTTOM_KING;
    if (cell === Cell.BOTTOM_KING) return Cell.TOP_KING;
    return cell;
  };
  const swapPlayer = (player) => {
    if (player === "top") return "bottom";
    if (player === "bottom") return "top";
    return player;
  };
  return {
    board: [...state.board].reverse().map((row) => [...row].reverse().map(swapCell)),
    turn: swapPlayer(state.turn),
    winner: swapPlayer(state.winner),
    draw: state.draw,
  };
}

/** Append color/rotation twins without changing their game-level split group. */
export function augmentRows(game, rows) {
  return rows.flatMap((row) => {
    const rotatedState = rotateAndSwapState(row.state);
    return [
      { ...row, augmentation: "original", features: extractFeatures(game, row.state) },
      {
        ...row,
        rowId: `${row.rowId}:rot180-swap`,
        augmentation: "rot180-swap",
        state: rotatedState,
        features: extractFeatures(game, rotatedState),
      },
    ];
  });
}

/** Give each complete game equal influence regardless of its sampled length. */
function weightedRows(rows) {
  const counts = new Map();
  for (const row of rows) counts.set(row.groupId, (counts.get(row.groupId) || 0) + 1);
  const groups = counts.size;
  return rows.map((row) => ({ row, weight: 1 / (groups * counts.get(row.groupId)) }));
}

/** Solve a small dense linear system using pivoted Gaussian elimination. */
function solveLinear(matrix, vector) {
  const size = vector.length;
  const augmented = matrix.map((row, index) => [...row, vector[index]]);
  for (let col = 0; col < size; col += 1) {
    let pivot = col;
    for (let row = col + 1; row < size; row += 1) {
      if (Math.abs(augmented[row][col]) > Math.abs(augmented[pivot][col])) pivot = row;
    }
    [augmented[col], augmented[pivot]] = [augmented[pivot], augmented[col]];
    if (Math.abs(augmented[col][col]) < 1e-10) augmented[col][col] = 1e-10;
    const divisor = augmented[col][col];
    for (let index = col; index <= size; index += 1) augmented[col][index] /= divisor;
    for (let row = 0; row < size; row += 1) {
      if (row === col) continue;
      const factor = augmented[row][col];
      for (let index = col; index <= size; index += 1) {
        augmented[row][index] -= factor * augmented[col][index];
      }
    }
  }
  return augmented.map((row) => row[size]);
}

/** Compute game-balanced train-only normalization parameters. */
function normalizer(rows, featureNames) {
  const weighted = weightedRows(rows);
  const mean = {};
  const scale = {};
  for (const name of featureNames) {
    mean[name] = weighted.reduce(
      (sum, { row, weight }) => sum + row.features[name] * weight,
      0,
    );
    const variance = weighted.reduce((sum, { row, weight }) => (
      sum + ((row.features[name] - mean[name]) ** 2) * weight
    ), 0);
    scale[name] = Math.max(1e-8, Math.sqrt(variance));
  }
  return { mean, scale };
}

/** Fit a ridge logistic model while projecting declared monotonic coefficients. */
export function fitMonotoneLogistic(
  rows,
  featureNames = FEATURE_NAMES,
  lambda = 0.01,
  constraints = MONOTONIC_CONSTRAINTS,
) {
  const normalization = normalizer(rows, featureNames);
  const dimensions = featureNames.length + 1;
  let coefficients = Array(dimensions).fill(0);
  for (let iteration = 0; iteration < 50; iteration += 1) {
    const gradient = Array(dimensions).fill(0);
    const hessian = Array.from({ length: dimensions }, () => Array(dimensions).fill(0));
    for (const { row, weight } of weightedRows(rows)) {
      const vector = [1, ...featureNames.map(
        (name) => (row.features[name] - normalization.mean[name]) / normalization.scale[name],
      )];
      const logit = vector.reduce((sum, value, index) => sum + value * coefficients[index], 0);
      const probability = sigmoid(logit);
      const curvature = Math.max(1e-8, probability * (1 - probability));
      for (let left = 0; left < dimensions; left += 1) {
        gradient[left] += weight * (probability - row.target) * vector[left];
        for (let right = 0; right < dimensions; right += 1) {
          hessian[left][right] += weight * curvature * vector[left] * vector[right];
        }
      }
    }
    for (let index = 1; index < dimensions; index += 1) {
      gradient[index] += lambda * coefficients[index];
      hessian[index][index] += lambda;
    }
    hessian[0][0] += 1e-9;
    const step = solveLinear(hessian, gradient);
    const next = coefficients.map((value, index) => {
      if (!Number.isFinite(step[index])) return value;
      return Math.max(-100, Math.min(100, value - step[index]));
    });
    for (let index = 0; index < featureNames.length; index += 1) {
      const direction = constraints[featureNames[index]];
      if (direction === "positive") next[index + 1] = Math.max(0, next[index + 1]);
      else if (direction === "negative") next[index + 1] = Math.min(0, next[index + 1]);
    }
    const maximumChange = Math.max(...next.map((value, index) => Math.abs(value - coefficients[index])));
    coefficients = next;
    if (maximumChange < 1e-8) break;
  }

  const raw = {};
  let intercept = coefficients[0];
  for (let index = 0; index < featureNames.length; index += 1) {
    const name = featureNames[index];
    raw[name] = coefficients[index + 1] / normalization.scale[name];
    intercept -= raw[name] * normalization.mean[name];
  }
  return { featureNames, raw, intercept, lambda, constraints };
}

/** Convert a model's raw linear value to a bounded win probability. */
export function predict(model, row) {
  let logit = model.intercept;
  for (const name of model.featureNames) logit += model.raw[name] * row.features[name];
  return sigmoid(logit);
}

/** Return a numerically stable logistic transform. */
export function sigmoid(value) {
  return 1 / (1 + Math.exp(-Math.max(-35, Math.min(35, value))));
}

/** Fit positive-slope Platt calibration on validation games only. */
export function calibrateModel(model, validationRows) {
  const calibrationRows = validationRows.map((row) => ({
    ...row,
    features: { rawLogit: modelLogit(model, row.features) },
  }));
  const calibration = fitMonotoneLogistic(
    calibrationRows,
    ["rawLogit"],
    0.001,
    { rawLogit: "positive" },
  );
  const slope = calibration.raw.rawLogit;
  return {
    ...model,
    calibration: { intercept: calibration.intercept, slope },
    intercept: calibration.intercept + slope * model.intercept,
    raw: Object.fromEntries(model.featureNames.map((name) => [name, slope * model.raw[name]])),
  };
}

/** Return an unbounded model logit for calibration and engine scaling. */
export function modelLogit(model, features) {
  let logit = model.intercept;
  for (const name of model.featureNames) logit += model.raw[name] * features[name];
  return logit;
}

/** Fit a calibrated one-dimensional probabilistic baseline. */
export function fitIncumbentBaseline(trainRows, validationRows) {
  const convert = (rows) => rows.map((row) => ({
    ...row,
    features: { incumbentScore: row.incumbentScore },
  }));
  const base = fitMonotoneLogistic(
    convert(trainRows),
    ["incumbentScore"],
    0.001,
    { incumbentScore: "positive" },
  );
  return calibrateModel(base, convert(validationRows));
}

/** Score discrimination and calibration with equal total weight per game. */
export function modelMetrics(model, rows) {
  let logLoss = 0;
  let brier = 0;
  let correct = 0;
  let decisiveWeight = 0;
  const bins = Array.from({ length: 10 }, () => ({ weight: 0, predicted: 0, actual: 0 }));
  for (const { row, weight } of weightedRows(rows)) {
    const prediction = predict(model, row);
    if (!Number.isFinite(prediction)) {
      throw new Error(`Non-finite prediction for game group ${row.groupId}.`);
    }
    const probability = Math.max(1e-9, Math.min(1 - 1e-9, prediction));
    logLoss -= weight * (
      row.target * Math.log(probability) + (1 - row.target) * Math.log(1 - probability)
    );
    brier += weight * ((probability - row.target) ** 2);
    if (row.target !== 0.5) {
      decisiveWeight += weight;
      if ((probability >= 0.5) === Boolean(row.target)) correct += weight;
    }
    const bin = bins[Math.min(9, Math.floor(probability * 10))];
    bin.weight += weight;
    bin.predicted += weight * probability;
    bin.actual += weight * row.target;
  }
  const calibrationError = bins.reduce((total, bin) => {
    if (!bin.weight) return total;
    return total + bin.weight * Math.abs(bin.predicted / bin.weight - bin.actual / bin.weight);
  }, 0);
  return {
    logLoss,
    brier,
    accuracy: decisiveWeight ? correct / decisiveWeight : 0,
    calibrationError,
  };
}

/** Select regularization by complete-game cross-validation inside training only. */
export function selectLambda(rows, featureNames, seed) {
  const candidates = [0.0003, 0.001, 0.003, 0.01, 0.03, 0.1, 0.3];
  const groups = [...new Set(rows.map((row) => row.groupId))];
  const random = randomSource(seed);
  for (let index = groups.length - 1; index > 0; index -= 1) {
    const swap = Math.floor(random() * (index + 1));
    [groups[index], groups[swap]] = [groups[swap], groups[index]];
  }
  const foldByGroup = new Map(groups.map((group, index) => [group, index % 4]));
  const results = candidates.map((lambda) => {
    let loss = 0;
    for (let fold = 0; fold < 4; fold += 1) {
      const fit = rows.filter((row) => foldByGroup.get(row.groupId) !== fold);
      const holdout = rows.filter((row) => foldByGroup.get(row.groupId) === fold);
      const model = fitMonotoneLogistic(fit, featureNames, lambda);
      loss += modelMetrics(model, holdout).logLoss;
    }
    return { lambda, logLoss: loss / 4 };
  }).sort((left, right) => left.logLoss - right.logLoss);
  return { selected: results[0].lambda, results };
}

/** Verify that no complete game or augmentation twin crosses a split boundary. */
export function assertNoGroupLeakage(partitions) {
  const owner = new Map();
  for (const [partition, rows] of Object.entries(partitions)) {
    for (const row of rows) {
      if (owner.has(row.groupId) && owner.get(row.groupId) !== partition) {
        throw new Error(`Game group ${row.groupId} leaked across partitions.`);
      }
      owner.set(row.groupId, partition);
    }
  }
  return owner.size;
}

/** Bootstrap a paired model improvement by resampling complete test games. */
export function bootstrapDelta(baseline, candidate, rows, samples, seed) {
  const byGroup = new Map();
  for (const row of rows) {
    if (!byGroup.has(row.groupId)) byGroup.set(row.groupId, []);
    byGroup.get(row.groupId).push(row);
  }
  const deltas = [...byGroup.values()].map((groupRows) => (
    modelMetrics(baseline, groupRows).logLoss - modelMetrics(candidate, groupRows).logLoss
  ));
  const random = randomSource(seed);
  const estimates = [];
  for (let sample = 0; sample < samples; sample += 1) {
    let total = 0;
    for (let draw = 0; draw < deltas.length; draw += 1) {
      total += deltas[Math.floor(random() * deltas.length)];
    }
    estimates.push(total / deltas.length);
  }
  estimates.sort((left, right) => left - right);
  return {
    mean: deltas.reduce((sum, value) => sum + value, 0) / deltas.length,
    low: estimates[Math.floor(samples * 0.025)],
    high: estimates[Math.min(samples - 1, Math.floor(samples * 0.975))],
    groups: deltas.length,
  };
}

/** Bootstrap raw coefficients by resampling complete training games. */
export function bootstrapWeights(rows, featureNames, lambda, samples, seed) {
  const groupIds = [...new Set(rows.map((row) => row.groupId))];
  const grouped = new Map(groupIds.map((id) => [id, rows.filter((row) => row.groupId === id)]));
  const random = randomSource(seed);
  const values = Object.fromEntries(featureNames.map((name) => [name, []]));
  for (let sample = 0; sample < samples; sample += 1) {
    const boot = [];
    for (let draw = 0; draw < groupIds.length; draw += 1) {
      const source = groupIds[Math.floor(random() * groupIds.length)];
      for (const row of grouped.get(source)) boot.push({ ...row, groupId: `${draw}:${source}` });
    }
    const model = fitMonotoneLogistic(boot, featureNames, lambda);
    for (const name of featureNames) values[name].push(model.raw[name]);
  }
  return Object.fromEntries(featureNames.map((name) => {
    const sorted = values[name].sort((left, right) => left - right);
    return [name, {
      low: sorted[Math.floor(samples * 0.025)],
      high: sorted[Math.min(samples - 1, Math.floor(samples * 0.975))],
      zeroRate: sorted.filter((value) => Math.abs(value) < 1e-10).length / samples,
    }];
  }));
}

/** Measure complete-game support for each named feature. */
export function featureCoverage(rows, featureNames = FEATURE_NAMES) {
  return Object.fromEntries(featureNames.map((name) => {
    const selected = rows.filter((row) => row.features[name] !== 0);
    return [name, {
      rows: selected.length,
      groups: new Set(selected.map((row) => row.groupId)).size,
      positiveRows: selected.filter((row) => row.features[name] > 0).length,
      negativeRows: selected.filter((row) => row.features[name] < 0).length,
    }];
  }));
}
