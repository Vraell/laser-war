import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import {
  dataSummary,
  renderReport,
  runExperiment,
} from "../experiments/eval_learned_value_experiment.mjs";

const projectRoot = resolve(import.meta.dirname, "..");

/** Parse the intentionally small learned-value experiment command line. */
function parseArguments(argv) {
  const options = {
    report: resolve(projectRoot, "experiments/eval_learned_value_report.md"),
    summary: resolve(projectRoot, "experiments/eval_learned_value_summary.json"),
    candidate: resolve(projectRoot, "experiments/eval_learned_value_candidate.json"),
    quick: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--report") options.report = resolve(argv[++index]);
    else if (argument === "--summary") options.summary = resolve(argv[++index]);
    else if (argument === "--candidate") options.candidate = resolve(argv[++index]);
    else if (argument === "--quick") options.quick = true;
    else if (argument === "--help") options.help = true;
    else throw new Error(`Unknown argument: ${argument}`);
  }
  return options;
}

/** Persist only the reproducible report, summary, and arena candidate payload. */
function writeArtifact(path, contents) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents);
}

/** Run the complete experiment and print concise progress and final evidence. */
async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) {
    console.log("Usage: node scripts/eval_learned_value_run.mjs [--quick] [--report FILE] [--summary FILE] [--candidate FILE]");
    return;
  }
  const quickConfig = options.quick ? {
    partitionConfig: {
      train: { games: 8, seed: 0x19a2f013 },
      validation: { games: 4, seed: 0x6b84d20f },
      test: { games: 4, seed: 0xd5317a91 },
    },
    bootstrapSamples: 12,
    bootstrapDeltaSamples: 200,
    targetLimit: 2,
    targetRollouts: 1,
  } : {};
  let lastProgress = 0;
  const result = await runExperiment(projectRoot, {
    ...quickConfig,
    onProgress: ({ partition, complete, games }) => {
      const now = performance.now();
      if (complete === games || now - lastProgress >= 1000) {
        console.log(`${partition}: ${complete}/${games} self-play games`);
        lastProgress = now;
      }
    },
  });
  writeArtifact(options.report, renderReport(result));
  writeArtifact(options.summary, `${JSON.stringify(dataSummary(result), null, 2)}\n`);
  writeArtifact(options.candidate, `${JSON.stringify(result.candidate, null, 2)}\n`);
  console.log(JSON.stringify({
    promotionReady: result.promotionReady,
    testLogLoss: result.metrics.candidate.test.logLoss,
    incumbentTestLogLoss: result.metrics.baseline.test.logLoss,
    testDelta: result.delta,
    report: options.report,
    summary: options.summary,
    candidate: options.candidate,
  }, null, 2));
}

await main();
