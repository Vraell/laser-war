import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const projectRoot = resolve(import.meta.dirname, "..");

/** Run the arena synchronously and retain both streams for fail-closed assertions. */
function runArena(argumentsList) {
  return spawnSync(process.execPath, ["scripts/elo_benchmark.mjs", ...argumentsList], {
    cwd: projectRoot,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
}

/** Parse the reproducibility manifest from a successful parent run. */
function manifest(result) {
  const line = result.stdout.split("\n").find((entry) => entry.startsWith("ARENA_MANIFEST "));
  assert.ok(line, `Arena emitted no manifest:\n${result.stdout}\n${result.stderr}`);
  return JSON.parse(line.slice("ARENA_MANIFEST ".length));
}

const common = [
  "--max-plies", "96",
  "--difficulties", "easy",
  "--candidate-ref", "HEAD",
  "--baseline-ref", "HEAD",
  "--resource", "nodes",
  "--ultra-nodes", "500",
  "--openings", "mixed",
  "--gate", "off",
  "--audit-identical",
];

const identical = runArena(["--pairs", "2", ...common]);
assert.equal(identical.status, 0, identical.stderr);
assert.match(identical.stdout, /Ptnml 0-0-2-0-0/);
const identicalManifest = manifest(identical);
for (const { hashes } of identicalManifest.sourceHashes) {
  assert.equal(hashes.candidate, hashes.baseline);
  assert.equal(hashes.candidateRules, hashes.baselineRules);
}

const identicalGate = runArena([
  "--pairs", "2",
  ...common.filter((argument, index, values) => (
    argument !== "--gate" && values[index - 1] !== "--gate"
  )),
  "--gate", "nonregression",
]);
assert.equal(identicalGate.status, 0, identicalGate.stderr);

const truncated = runArena([
  "--pairs", "1",
  "--max-plies", "1",
  "--difficulties", "hard",
  "--candidate-ref", "HEAD",
  "--baseline-ref", "HEAD",
  "--resource", "nodes",
  "--ultra-nodes", "500",
  "--openings", "generated",
  "--gate", "nonregression",
  "--audit-identical",
]);
assert.notEqual(truncated.status, 0, "A truncated batch must never become neutral Elo evidence.");
assert.match(truncated.stderr, /invalidated 2 game/);

const combined = runArena(["--pairs", "2", "--pair-offset", "5", ...common]);
const first = runArena(["--pairs", "1", "--pair-offset", "5", ...common]);
const second = runArena(["--pairs", "1", "--pair-offset", "6", ...common]);
assert.equal(combined.status, 0, combined.stderr);
assert.equal(first.status, 0, first.stderr);
assert.equal(second.status, 0, second.stderr);
assert.deepEqual(
  manifest(combined).openingIds,
  [...manifest(first).openingIds, ...manifest(second).openingIds],
  "Chunked and resumed runs must cover exactly the same opening IDs.",
);

const inferior = runArena([
  "--pairs", "4",
  "--max-plies", "96",
  "--difficulties", "hard",
  "--candidate-ref", "HEAD",
  "--baseline-ref", "HEAD",
  "--candidate-ai", "experiments/arena_audit/first_legal_ai.js",
  "--resource", "nodes",
  "--ultra-nodes", "500",
  "--openings", "mixed",
  "--gate", "nonregression",
]);
assert.notEqual(inferior.status, 0, "A known-inferior engine must fail qualification.");
assert.match(inferior.stderr, /failed the nonregression gate/);

const confirmation = runArena([
  "--pairs", "2",
  "--opening-plies", "8,12",
  ...common.filter((argument, index, values) => (
    argument !== "--openings" && values[index - 1] !== "--openings"
  )),
  "--openings", "confirmation",
]);
assert.equal(confirmation.status, 0, confirmation.stderr);
assert.notEqual(manifest(confirmation).openingHash, identicalManifest.openingHash);
assert.match(manifest(confirmation).harnessHash, /^[a-f0-9]{12}$/);

const workflow = readFileSync(resolve(projectRoot, ".github/workflows/pages.yml"), "utf8");
assert.doesNotMatch(
  workflow,
  /--baseline-ref HEAD\^/,
  "A failed preceding commit must never become the production qualification baseline.",
);
assert.match(workflow, /status: "success"/);
assert.equal(
  workflow.match(/^\s+- suite:/gm)?.length,
  12,
  "Ultra qualification must retain all twelve independently hosted shards.",
);

console.log("Arena isolation, qualification, holdout, truncation, and offset checks passed.");
