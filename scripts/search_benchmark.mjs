import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const projectRoot = resolve(import.meta.dirname, "..");
const webFiles = ["ai.js", "engine.js", "exact_routes.js", "tactics.js", "minisat.js"];
const baselineRef = process.argv[2] || "HEAD";
const SEARCH_PROFILE = {
  timeLimit: Infinity,
  maxDepth: 3,
  rootLimit: 16,
  branchLimits: [14, 10, 7],
  proofMaxNodes: 0,
};
const positions = [
  ["ultra_loss_30_move_log.json", 12],
  ["ultra_root_pruning_31_move_log.json", 23],
  ["ultra_choke_46_move_log.json", 40],
];

/** Materialize one complete web engine revision as an isolated module graph. */
async function loadRevision(label, reference = null) {
  const directory = mkdtempSync(join(tmpdir(), `laser-war-search-${label}-`));
  for (const file of webFiles) {
    const source = reference
      ? execFileSync("git", ["show", `${reference}:web/${file}`], {
        cwd: projectRoot,
        encoding: "utf8",
        maxBuffer: 2 * 1024 * 1024,
      })
      : readFileSync(join(projectRoot, "web", file), "utf8");
    writeFileSync(join(directory, file), source);
  }
  const revision = {
    ai: await import(`${pathToFileURL(join(directory, "ai.js")).href}?revision=${label}`),
    engine: await import(`${pathToFileURL(join(directory, "engine.js")).href}?revision=${label}`),
  };
  revision.dispose = () => rmSync(directory, { recursive: true, force: true });
  return revision;
}

/** Replay a historical log to one deterministic benchmark position. */
function replayPosition(revision, fixtureName, plies) {
  const game = new revision.engine.Game();
  const fixture = JSON.parse(readFileSync(
    join(projectRoot, "web", "fixtures", fixtureName),
    "utf8",
  ));
  let state = game.initialState();
  for (const [row, col, mirror] of fixture.moves.slice(0, plies)) {
    state = game.resolveMove(
      state,
      { row: row - 1, col: col - 1, mirror },
      false,
      false,
    ).state;
  }
  return { game, state };
}

/** Measure identical fixed-depth searches without timing cutoffs. */
function measureRevision(revision) {
  let milliseconds = 0;
  let nodes = 0;
  for (const [fixture, plies] of positions) {
    const { game, state } = replayPosition(revision, fixture, plies);
    const search = new revision.ai.UltraSearch(game, () => 0, SEARCH_PROFILE);
    const started = performance.now();
    const result = search.choose(state);
    milliseconds += performance.now() - started;
    nodes += result.nodes;
    if (!game.isLegalMove(state, result.move)) {
      throw new Error(`${fixture} produced an illegal benchmark move.`);
    }
  }
  return { milliseconds, nodes };
}

const [candidate, baseline] = await Promise.all([
  loadRevision("candidate"),
  loadRevision("baseline", baselineRef),
]);
try {
  const samples = { candidate: [], baseline: [] };
  for (let run = 0; run < 3; run += 1) {
    const order = run % 2
      ? [["baseline", baseline], ["candidate", candidate]]
      : [["candidate", candidate], ["baseline", baseline]];
    for (const [label, revision] of order) {
      samples[label].push(measureRevision(revision));
    }
  }
  const median = (results) => [...results].sort(
    (left, right) => left.milliseconds - right.milliseconds,
  )[1];
  const baselineResult = median(samples.baseline);
  const candidateResult = median(samples.candidate);
  const ratio = candidateResult.milliseconds / baselineResult.milliseconds;
  console.log(
    `Search benchmark · ${positions.length} positions at depth ${SEARCH_PROFILE.maxDepth}`,
  );
  console.log(
    `candidate ${candidateResult.milliseconds.toFixed(0)} ms / `
    + `${candidateResult.nodes.toLocaleString()} positions`,
  );
  console.log(
    `baseline  ${baselineResult.milliseconds.toFixed(0)} ms / `
    + `${baselineResult.nodes.toLocaleString()} positions`,
  );
  console.log(`wall-clock ratio ${(ratio * 100).toFixed(1)}% vs ${baselineRef}`);
  if (ratio > 0.8) {
    throw new Error("Candidate did not establish the required 20% search speedup.");
  }
} finally {
  candidate.dispose();
  baseline.dispose();
}
