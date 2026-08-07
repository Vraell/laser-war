import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { passesArenaGate, summarizePairs } from "./arena_stats.mjs";

/** Recursively collect JSON reports from an artifact directory. */
function reportPaths(directory) {
  return readdirSync(directory).flatMap((name) => {
    const path = resolve(directory, name);
    return statSync(path).isDirectory()
      ? reportPaths(path)
      : name.endsWith(".json") ? [path] : [];
  });
}

/** Parse the aggregation command line without accepting ambiguous inputs. */
function parseArguments(argv) {
  const options = {
    input: null,
    openings: null,
    expectedPairs: null,
    difficulty: "ultra",
    gate: "nonregression",
    output: null,
    expectedShards: null,
    maxPlies: null,
    resource: null,
    ultraNodes: null,
    seedOffset: null,
    openingPlies: null,
    candidateRef: null,
    baselineRef: null,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--input") options.input = argv[++index];
    else if (argument === "--openings") options.openings = argv[++index];
    else if (argument === "--expected-pairs") options.expectedPairs = Number(argv[++index]);
    else if (argument === "--difficulty") options.difficulty = argv[++index];
    else if (argument === "--gate") options.gate = argv[++index];
    else if (argument === "--output") options.output = argv[++index];
    else if (argument === "--expected-shards") options.expectedShards = Number(argv[++index]);
    else if (argument === "--max-plies") options.maxPlies = Number(argv[++index]);
    else if (argument === "--resource") options.resource = argv[++index];
    else if (argument === "--ultra-nodes") options.ultraNodes = Number(argv[++index]);
    else if (argument === "--seed-offset") options.seedOffset = Number(argv[++index]);
    else if (argument === "--opening-plies") options.openingPlies = argv[++index].split(",").map(Number);
    else if (argument === "--candidate-ref") options.candidateRef = argv[++index];
    else if (argument === "--baseline-ref") options.baselineRef = argv[++index];
    else throw new Error(`Unknown argument: ${argument}`);
  }
  if (!options.input) throw new Error("--input is required.");
  if (!options.openings) throw new Error("--openings is required.");
  if (!Number.isInteger(options.expectedPairs) || options.expectedPairs < 1) {
    throw new Error("--expected-pairs must be positive.");
  }
  if (!["off", "nonregression", "improvement"].includes(options.gate)) {
    throw new Error("--gate must be off, nonregression, or improvement.");
  }
  return options;
}

/** Validate and combine independent arena shards into one release decision. */
export function aggregateArenaReports(reports, options) {
  const selected = reports.filter((report) => (
    report.options?.openings === options.openings
    && report.options?.difficulties?.length === 1
    && report.options.difficulties[0] === options.difficulty
  ));
  if (!selected.length) {
    throw new Error(`No ${options.difficulty}/${options.openings} arena reports found.`);
  }

  const ordered = [...selected].sort((left, right) => (
    left.options.pairOffset - right.options.pairOffset
  ));
  let expectedOffset = 0;
  const pairScores = [];
  const openingIds = [];
  const referenceForfeits = [];
  let sourceHashes = null;
  let harnessHash = null;
  let shardConfiguration = null;
  const configurationFields = [
    "maxPlies",
    "resource",
    "ultraNodes",
    "seedOffset",
    "openingPlies",
    "candidateRef",
    "baselineRef",
  ];
  for (const report of ordered) {
    if (report.schema !== "laser-war-arena-v3") {
      throw new Error(`Unsupported arena schema: ${report.schema || "missing"}.`);
    }
    if (report.options.gate !== "off") throw new Error("Shard gates must be disabled before aggregation.");
    if (!/^[a-f0-9]{12}$/.test(report.harnessHash || "")) {
      throw new Error("Arena shard has no valid harness hash.");
    }
    if (harnessHash === null) harnessHash = report.harnessHash;
    else if (report.harnessHash !== harnessHash) throw new Error("Arena shards used different harnesses.");
    const configuration = JSON.stringify(Object.fromEntries(
      configurationFields.map((field) => [field, report.options[field]]),
    ));
    if (shardConfiguration === null) shardConfiguration = configuration;
    else if (configuration !== shardConfiguration) {
      throw new Error("Arena shards used incompatible qualification settings.");
    }
    if (report.options.pairOffset !== expectedOffset) {
      throw new Error(`Arena shard coverage expected pair ${expectedOffset}, found ${report.options.pairOffset}.`);
    }
    const qualification = report.qualification?.find(
      ({ difficulty }) => difficulty === options.difficulty,
    );
    if (!qualification) throw new Error("Arena shard has no matching qualification payload.");
    if (qualification.invalid?.length) throw new Error("Arena shard contains invalid candidate games.");
    if (qualification.pairScores.length !== report.options.pairs) {
      throw new Error("Arena shard pair count does not match its declared size.");
    }
    if (qualification.openingIds.length !== report.options.pairs) {
      throw new Error("Arena shard opening count does not match its declared size.");
    }
    const hashes = JSON.stringify(qualification.sourceHashes);
    if (sourceHashes === null) sourceHashes = hashes;
    else if (hashes !== sourceHashes) throw new Error("Arena shards executed different source bundles.");
    pairScores.push(...qualification.pairScores);
    openingIds.push(...qualification.openingIds);
    referenceForfeits.push(...(qualification.forfeits || []));
    expectedOffset += report.options.pairs;
  }
  if (expectedOffset !== options.expectedPairs) {
    throw new Error(`Arena covered ${expectedOffset} pairs; expected ${options.expectedPairs}.`);
  }
  if (options.expectedShards !== null && ordered.length !== options.expectedShards) {
    throw new Error(`Arena used ${ordered.length} shards; expected ${options.expectedShards}.`);
  }
  const actualConfiguration = JSON.parse(shardConfiguration);
  for (const field of configurationFields) {
    if (options[field] === null || options[field] === undefined) continue;
    if (JSON.stringify(actualConfiguration[field]) !== JSON.stringify(options[field])) {
      throw new Error(
        `Arena ${field} was ${JSON.stringify(actualConfiguration[field])}; `
        + `expected ${JSON.stringify(options[field])}.`,
      );
    }
  }
  if (new Set(openingIds).size !== openingIds.length) {
    throw new Error("Arena shards contain duplicate openings.");
  }

  const summary = summarizePairs(pairScores);
  if (!passesArenaGate(summary, options.gate)) {
    throw new Error(`Candidate failed the ${options.gate} aggregate gate.`);
  }
  return {
    schema: "laser-war-arena-aggregate-v1",
    difficulty: options.difficulty,
    openings: options.openings,
    shardCount: ordered.length,
    pairCount: pairScores.length,
    openingIds,
    sourceHashes: JSON.parse(sourceHashes),
    harnessHash,
    configuration: actualConfiguration,
    referenceForfeits,
    result: summary,
  };
}

/** Load artifact reports and print the reconstructed release verdict. */
function main() {
  const options = parseArguments(process.argv.slice(2));
  const paths = reportPaths(resolve(options.input));
  const reports = paths.map((path) => JSON.parse(readFileSync(path, "utf8")));
  const aggregate = aggregateArenaReports(reports, options);
  const { result } = aggregate;
  console.log(
    `${options.difficulty}/${options.openings} · ${result.games} games · `
    + `${Math.round(result.elo) >= 0 ? "+" : ""}${Math.round(result.elo)} Elo `
    + `[${Math.round(result.lowElo)}, ${Math.round(result.highElo)}] · `
    + `Ptnml ${result.pentanomial.join("-")}`,
  );
  if (aggregate.referenceForfeits.length) {
    console.log(`Reference forfeits: ${aggregate.referenceForfeits.length}.`);
  }
  if (options.output) writeFileSync(options.output, `${JSON.stringify(aggregate, null, 2)}\n`);
  console.log(`ARENA_AGGREGATE ${JSON.stringify(aggregate)}`);
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) main();
