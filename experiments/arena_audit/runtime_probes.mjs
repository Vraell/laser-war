import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const projectRoot = resolve(import.meta.dirname, "../..");
const weakEnginePath = join(import.meta.dirname, "first_legal_ai.js");
const slowEnginePath = join(import.meta.dirname, "slow_ai.js");
const sentinelEnginePath = join(import.meta.dirname, "engine_sentinel_ai.js");

/** Run a command in the audited repository and return its standard output. */
function run(command, argumentsList, options = {}) {
  return execFileSync(command, argumentsList, {
    cwd: projectRoot,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    ...options,
  });
}

/** Create an unreachable commit containing one audit engine without changing refs or files. */
function auditCommit(replacements, message) {
  const temporary = mkdtempSync(join(tmpdir(), "laser-war-arena-audit-"));
  const environment = {
    ...process.env,
    GIT_INDEX_FILE: join(temporary, "index"),
    GIT_AUTHOR_NAME: "Arena Audit",
    GIT_AUTHOR_EMAIL: "arena-audit@invalid",
    GIT_COMMITTER_NAME: "Arena Audit",
    GIT_COMMITTER_EMAIL: "arena-audit@invalid",
    GIT_AUTHOR_DATE: "2000-01-01T00:00:00Z",
    GIT_COMMITTER_DATE: "2000-01-01T00:00:00Z",
  };
  try {
    run("git", ["read-tree", "HEAD"], { env: environment });
    for (const [path, source] of Object.entries(replacements)) {
      const blob = run(
        "git",
        ["hash-object", "-w", "--stdin"],
        { env: environment, input: source },
      ).trim();
      run(
        "git",
        ["update-index", "--add", "--cacheinfo", `100644,${blob},${path}`],
        { env: environment },
      );
    }
    const tree = run("git", ["write-tree"], { env: environment }).trim();
    return run(
      "git",
      ["commit-tree", tree, "-p", "HEAD"],
      { env: environment, input: `${message}\n` },
    ).trim();
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

/** Invoke the production arena with a fixed candidate and baseline revision. */
function arena(candidate, extraArguments) {
  return run(process.execPath, [
    "scripts/elo_benchmark.mjs",
    "--candidate-ref", candidate,
    "--baseline-ref", "HEAD",
    "--difficulties", "hard",
    "--pairs", "8",
    "--opening-plies", "0,2,4,6",
    "--openings", "generated",
    "--resource", "nodes",
    "--ultra-nodes", "500",
    ...extraArguments,
  ]);
}

/** Capture an arena failure as evidence without hiding its diagnostics. */
function arenaFailure(callback) {
  try {
    callback();
  } catch (error) {
    return `${error.stdout || ""}\n${error.stderr || ""}\n${error.message || ""}`;
  }
  throw new Error("The arena unexpectedly accepted an invalid audit batch.");
}

const weakCommit = auditCommit(
  { "web/ai.js": readFileSync(weakEnginePath) },
  "Arena audit weak engine",
);
const strengthRun = arena(weakCommit, ["--max-plies", "72", "--gate", "off"]);
const strengthMatch = strengthRun.match(/hard\s+(\d+)-(\d+)-(\d+)/);
assert.ok(strengthMatch, "The full-game audit did not report a Hard W/D/L result.");
const [, weakWins, weakDraws, weakLosses] = strengthMatch.map(Number);

const truncatedFailure = arenaFailure(() => arena(weakCommit, [
  "--max-plies", "1",
  "--gate", "nonregression",
 ]));
assert.match(truncatedFailure, /invalidated 16 game/);

console.log(`Weak engine full games: ${weakWins}-${weakDraws}-${weakLosses}.`);
console.log("Truncation defense verified: all 16 one-ply games invalidated the batch.");

const slowCommit = auditCommit(
  { "web/ai.js": readFileSync(slowEnginePath) },
  "Arena audit timeout engine",
);
const timeoutFailure = arenaFailure(() => run(process.execPath, [
  "scripts/elo_benchmark.mjs",
  "--candidate-ref", "HEAD",
  "--baseline-ref", slowCommit,
  "--difficulties", "hard",
  "--pairs", "1",
  "--opening-plies", "0",
  "--openings", "generated",
  "--max-plies", "2",
  "--resource", "nodes",
  "--ultra-nodes", "500",
  "--gate", "improvement",
]));
assert.match(timeoutFailure, /invalidated 2 game/);
console.log("Timeout symmetry verified: two baseline watchdog violations invalidated the batch.");

const currentEngine = run("git", ["show", "HEAD:web/engine.js"]);
const sentinelCommit = auditCommit({
  "web/ai.js": readFileSync(sentinelEnginePath),
  "web/engine.js": `${currentEngine}\nexport const ARENA_AUDIT_REVISION_SENTINEL = true;\n`,
}, "Arena audit isolated rules engine");
const isolationOutput = run(process.execPath, [
  "scripts/elo_benchmark.mjs",
  "--candidate-ref", sentinelCommit,
  "--baseline-ref", sentinelCommit,
  "--difficulties", "hard",
  "--pairs", "1",
  "--opening-plies", "0",
  "--openings", "generated",
  "--max-plies", "1",
  "--resource", "nodes",
  "--ultra-nodes", "500",
  "--gate", "off",
  "--audit-identical",
], { env: { ...process.env, LASER_WAR_ARENA_CHILD: "1" } });
assert.match(isolationOutput, /ARENA_RESULT/);
assert.match(isolationOutput, /"candidateRules":"[a-f0-9]+"/);
console.log("Revision isolation verified: an AI imported a symbol from its own engine.js bundle.");
