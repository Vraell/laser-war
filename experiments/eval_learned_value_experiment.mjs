import { Game } from "../web/engine.js";
import {
  PARTITION_CONFIG,
  generateSelfPlayPartition,
  huntDedicatedRows,
  loadHistoricalFixtures,
  rareStateCohorts,
} from "./eval_learned_value_data.mjs";
import {
  FEATURE_FAMILIES,
  FEATURE_NAMES,
  MONOTONIC_CONSTRAINTS,
  assertNoGroupLeakage,
  bootstrapDelta,
  bootstrapWeights,
  calibrateModel,
  featureCoverage,
  fitIncumbentBaseline,
  fitMonotoneLogistic,
  modelMetrics,
  selectLambda,
} from "./eval_learned_value_model.mjs";

const ENGINE_POINTS_PER_LOG_ODDS = 300;

/** Return the largest symmetry residual across all augmented feature twins. */
function symmetryResidual(rows) {
  const originals = new Map(rows.filter((row) => row.augmentation === "original")
    .map((row) => [row.rowId, row]));
  let maximum = 0;
  for (const row of rows.filter((item) => item.augmentation === "rot180-swap")) {
    const original = originals.get(row.rowId.replace(/:rot180-swap$/, ""));
    if (!original) continue;
    for (const name of FEATURE_NAMES) {
      maximum = Math.max(maximum, Math.abs(original.features[name] - row.features[name]));
    }
    maximum = Math.max(maximum, Math.abs(original.incumbentScore - row.incumbentScore));
  }
  return maximum;
}

/** Fit every leave-one-family-out model using training and validation only. */
function runAblations(trainRows, validationRows, testRows, seed) {
  const results = {};
  for (const [family, removed] of Object.entries(FEATURE_FAMILIES)) {
    const features = FEATURE_NAMES.filter((name) => !removed.includes(name));
    const selection = selectLambda(trainRows, features, seed ^ family.length * 7919);
    const fitted = fitMonotoneLogistic(trainRows, features, selection.selected);
    const calibrated = calibrateModel(fitted, validationRows);
    results[family] = {
      removed,
      lambda: selection.selected,
      validation: modelMetrics(calibrated, validationRows),
      test: modelMetrics(calibrated, testRows),
    };
  }
  return results;
}

/** Compare baseline and candidate on one predeclared rare-state cohort. */
function cohortEvidence(baseline, candidate, cohorts) {
  return Object.fromEntries(Object.entries(cohorts).map(([name, rows]) => [name, {
    rows: rows.length,
    groups: new Set(rows.map((row) => row.groupId)).size,
    baseline: rows.length ? modelMetrics(baseline, rows) : null,
    candidate: rows.length ? modelMetrics(candidate, rows) : null,
    averageDefenseResources: name === "forcedDefense" && rows.length
      ? rows.reduce((sum, row) => sum + row.defenseResources, 0) / rows.length
      : null,
  }]));
}

/** Benchmark feature extraction on cold and cache-warmed position streams. */
function speedEvidence(rows) {
  const sample = rows.filter((row) => row.augmentation === "original").slice(0, 240);
  const game = new Game();
  const extract = async () => {
    const module = await import("./eval_learned_value_model.mjs");
    return module.extractFeatures;
  };
  return extract().then((extractFeatures) => {
    let checksum = 0;
    const coldStarted = performance.now();
    for (const row of sample) checksum += extractFeatures(game, row.state).attackTempo;
    const coldMilliseconds = performance.now() - coldStarted;
    const warmStarted = performance.now();
    for (let repeat = 0; repeat < 20; repeat += 1) {
      for (const row of sample) checksum += extractFeatures(game, row.state).reserveTempo;
    }
    const warmMilliseconds = performance.now() - warmStarted;
    return {
      positions: sample.length,
      coldMicrosecondsPerPosition: coldMilliseconds * 1000 / Math.max(1, sample.length),
      warmMicrosecondsPerPosition: warmMilliseconds * 1000 / Math.max(1, sample.length * 20),
      checksum,
    };
  });
}

/** Build one compact arena adapter payload from the calibrated model. */
function candidatePayload(model, evidence) {
  return {
    format: 1,
    label: "learned-monotonic-value-v1",
    productionBaseline: "v0.13.6 / 6536122",
    perspective: "side-to-move",
    featureNames: model.featureNames,
    monotonicConstraints: Object.fromEntries(
      model.featureNames.map((name) => [name, MONOTONIC_CONSTRAINTS[name]]),
    ),
    logOddsIntercept: model.intercept,
    logOddsWeights: model.raw,
    enginePointsPerLogOdds: ENGINE_POINTS_PER_LOG_ODDS,
    engineIntercept: model.intercept * ENGINE_POINTS_PER_LOG_ODDS,
    engineWeights: Object.fromEntries(
      model.featureNames.map((name) => [name, model.raw[name] * ENGINE_POINTS_PER_LOG_ODDS]),
    ),
    clamp: { minimum: -9000, maximum: 9000 },
    evidence,
  };
}

/** Run independent generation, fitting, calibration, ablations, and test evaluation. */
export async function runExperiment(projectRoot, {
  partitionConfig = PARTITION_CONFIG,
  bootstrapSamples = 160,
  bootstrapDeltaSamples = 3000,
  targetLimit = 16,
  targetRollouts = 3,
  onProgress = () => {},
} = {}) {
  const generated = {};
  for (const partition of ["train", "validation", "test"]) {
    generated[partition] = generateSelfPlayPartition(partition, {
      ...partitionConfig[partition],
      onProgress,
    });
  }
  const historical = loadHistoricalFixtures(projectRoot);
  const partitions = {};
  const targetedMetadata = {};
  for (const partition of ["train", "validation", "test"]) {
    const base = [...generated[partition].rows, ...historical.partitions[partition]];
    const targeted = huntDedicatedRows(base, partition, {
      limit: targetLimit,
      rollouts: targetRollouts,
    });
    partitions[partition] = [...base, ...targeted];
    targetedMetadata[partition] = {
      rows: targeted.length,
      groups: new Set(targeted.map((row) => row.groupId)).size,
    };
  }

  const groups = assertNoGroupLeakage(partitions);
  const symmetry = symmetryResidual(Object.values(partitions).flat());
  const selection = selectLambda(partitions.train, FEATURE_NAMES, 0x41c0ffee);
  const fitted = fitMonotoneLogistic(partitions.train, FEATURE_NAMES, selection.selected);
  const candidate = calibrateModel(fitted, partitions.validation);
  const baseline = fitIncumbentBaseline(partitions.train, partitions.validation);
  const metrics = {
    baseline: {
      train: modelMetrics(baseline, partitions.train),
      validation: modelMetrics(baseline, partitions.validation),
      test: modelMetrics(baseline, partitions.test),
    },
    candidate: {
      train: modelMetrics(candidate, partitions.train),
      validation: modelMetrics(candidate, partitions.validation),
      test: modelMetrics(candidate, partitions.test),
    },
  };
  const delta = bootstrapDelta(
    baseline,
    candidate,
    partitions.test,
    bootstrapDeltaSamples,
    0x72a11ce,
  );
  const ablations = runAblations(
    partitions.train,
    partitions.validation,
    partitions.test,
    0xab1a710,
  );
  const uncalibratedIntervals = bootstrapWeights(
    partitions.train,
    FEATURE_NAMES,
    selection.selected,
    bootstrapSamples,
    0xc01ff1d,
  );
  const calibrationSlope = candidate.calibration.slope;
  const intervals = Object.fromEntries(Object.entries(uncalibratedIntervals).map(
    ([name, interval]) => [name, {
      ...interval,
      low: interval.low * calibrationSlope,
      high: interval.high * calibrationSlope,
    }],
  ));
  const rare = cohortEvidence(
    baseline,
    candidate,
    rareStateCohorts(partitions.test),
  );
  const speed = await speedEvidence(partitions.test);
  const coverage = featureCoverage(partitions.train);
  const monotonic = FEATURE_NAMES.every((name) => candidate.raw[name] >= -1e-12);
  const gates = {
    noLeakage: groups > 0,
    symmetry: symmetry < 1e-12,
    monotonic,
    testMeanImprovement: delta.mean > 0,
    testConfidence: delta.low > 0,
    dedicatedCoverage: coverage.dedicatedLaserBalance.groups >= 8,
    rareTestCoverage: Object.values(rare).every((cohort) => cohort.groups >= 2),
  };
  const promotionReady = Object.values(gates).every(Boolean);
  const evidence = {
    promotionReady,
    gates,
    metrics,
    testLogLossDelta: delta,
    coefficientConfidence95: intervals,
  };
  return {
    metadata: {
      generated: Object.fromEntries(Object.entries(generated).map(([name, result]) => [name, result.metadata])),
      historical: historical.audit,
      targeted: targetedMetadata,
      rows: Object.fromEntries(Object.entries(partitions).map(([name, rows]) => [name, rows.length])),
      groups: Object.fromEntries(Object.entries(partitions).map(([name, rows]) => [
        name,
        new Set(rows.map((row) => row.groupId)).size,
      ])),
      independentSeeds: Object.fromEntries(
        Object.entries(partitionConfig).map(([name, config]) => [name, config.seed]),
      ),
      symmetryMaximumResidual: symmetry,
      totalGroups: groups,
    },
    selection,
    model: candidate,
    baseline,
    metrics,
    delta,
    ablations,
    intervals,
    coverage,
    rare,
    speed,
    gates,
    promotionReady,
    candidate: candidatePayload(candidate, evidence),
  };
}

/** Render a concise evidence report without serializing raw game positions. */
export function renderReport(result) {
  const metricRow = (name, metric) => (
    `| ${name} | ${metric.train.logLoss.toFixed(4)} | ${metric.validation.logLoss.toFixed(4)} | `
    + `${metric.test.logLoss.toFixed(4)} | ${metric.test.brier.toFixed(4)} | `
    + `${(metric.test.accuracy * 100).toFixed(1)}% | ${(metric.test.calibrationError * 100).toFixed(1)}% |`
  );
  const ablationRows = Object.entries(result.ablations).map(([name, value]) => {
    const contribution = value.test.logLoss - result.metrics.candidate.test.logLoss;
    return `| ${name} | ${value.removed.join(", ")} | ${value.test.logLoss.toFixed(4)} | ${contribution.toFixed(4)} |`;
  }).join("\n");
  const coefficientRows = FEATURE_NAMES.map((name) => {
    const interval = result.intervals[name];
    return `| ${name} | ${result.model.raw[name].toFixed(5)} | ${interval.low.toFixed(5)} | `
      + `${interval.high.toFixed(5)} | ${(interval.zeroRate * 100).toFixed(1)}% |`;
  }).join("\n");
  const rareRows = Object.entries(result.rare).map(([name, evidence]) => {
    const baseline = evidence.baseline?.logLoss;
    const candidate = evidence.candidate?.logLoss;
    return `| ${name} | ${evidence.rows} | ${evidence.groups} | `
      + `${baseline === undefined ? "n/a" : baseline.toFixed(4)} | `
      + `${candidate === undefined ? "n/a" : candidate.toFixed(4)} | `
      + `${baseline === undefined ? "n/a" : (baseline - candidate).toFixed(4)} |`;
  }).join("\n");
  const generatedRows = Object.entries(result.metadata.generated).map(([name, data]) => (
    `| ${name} | ${data.games} | ${data.seed} | ${data.rawRows} | ${data.augmentedRows} | `
    + `${data.outcomes.top}/${data.outcomes.bottom}/${data.outcomes.draw}/${data.outcomes.unfinished} |`
  )).join("\n");
  const gates = Object.entries(result.gates).map(([name, passed]) => `- ${name}: **${passed ? "pass" : "fail"}**`).join("\n");
  return `# Learned monotonic value experiment

Production AI code was not edited. This experiment fits a compact side-to-move value model from complete self-play games and replayable historical fixtures, calibrates it on a separate validation seed, and evaluates it once on an untouched test seed.

## Data discipline

| Partition | Self-play games | Seed | Raw sampled rows | With rotation/color augmentation | Outcomes top/bottom/draw/unfinished |
|---|---:|---:|---:|---:|---:|
${generatedRows}

- Final rows: train ${result.metadata.rows.train}, validation ${result.metadata.rows.validation}, test ${result.metadata.rows.test}.
- Complete-game groups: train ${result.metadata.groups.train}, validation ${result.metadata.groups.validation}, test ${result.metadata.groups.test}.
- Maximum rotation/color feature residual: ${result.metadata.symmetryMaximumResidual.toExponential(2)}.
- Historical fixtures are included only when they replay legally to a terminal result; all exclusions are listed in the JSON summary.
- Regularization was selected by grouped four-fold cross-validation inside training. Validation was then used only for positive-slope probability calibration. Test was untouched until final scoring.

## Held-out evidence

| Model | Train log loss | Validation log loss | Test log loss | Test Brier | Test accuracy | Test calibration error |
|---|---:|---:|---:|---:|---:|---:|
${metricRow("Calibrated incumbent", result.metrics.baseline)}
${metricRow("Learned monotonic", result.metrics.candidate)}

Paired test log-loss improvement: **${result.delta.mean.toFixed(4)}**, game-bootstrap 95% CI **${result.delta.low.toFixed(4)} to ${result.delta.high.toFixed(4)}** across ${result.delta.groups} complete games.

## Ablations

Positive contribution means removing that family made untouched-test log loss worse. Test values are diagnostics; feature definitions and model selection were frozen before test scoring.

| Removed family | Features | Test log loss | Full-model contribution |
|---|---|---:|---:|
${ablationRows}

## Coefficients

Every feature is signed so that larger is better for the side to move and constrained nonnegative. Intervals resample complete training games.

| Feature | Calibrated log-odds weight | 2.5% | 97.5% | Bootstrap at zero |
|---|---:|---:|---:|---:|
${coefficientRows}

## Dedicated tactical cohorts

| Cohort | Rows | Games | Incumbent log loss | Candidate log loss | Improvement |
|---|---:|---:|---:|---:|---:|
${rareRows}

The forced-defense cohort requires a currently exposed own king and at least one legal survival among otherwise losing replies. Dedicated-laser rows require one laser to be permanently assigned to exactly one king. Cascade rows measure newly exposed kings after the current shield contacts are removed.

## Runtime

- Cold extraction: ${result.speed.coldMicrosecondsPerPosition.toFixed(1)} microseconds/position over ${result.speed.positions} positions.
- Cache-warmed extraction: ${result.speed.warmMicrosecondsPerPosition.toFixed(1)} microseconds/position.
- Candidate payload scale: ${ENGINE_POINTS_PER_LOG_ODDS} evaluation points per log-odds unit, clamped below mate scores.

## Gates

${gates}

**Decision: ${result.promotionReady ? "candidate cleared the offline promotion gates and is ready for a fixed-node arena." : "candidate is arena-ready for diagnosis but did not clear every offline promotion gate; do not promote it to production yet."}**
`;
}

/** Reduce a full run to a committed data summary without raw positions. */
export function dataSummary(result) {
  return {
    format: 1,
    experiment: "eval_learned_value_v1",
    metadata: result.metadata,
    selectedLambda: result.selection.selected,
    lambdaCrossValidation: result.selection.results,
    metrics: result.metrics,
    pairedTestDelta: result.delta,
    ablations: result.ablations,
    coefficientConfidence95: result.intervals,
    featureCoverage: result.coverage,
    rareStateEvidence: result.rare,
    speed: result.speed,
    gates: result.gates,
    promotionReady: result.promotionReady,
  };
}
