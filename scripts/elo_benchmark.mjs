import { execFile, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { passesArenaGate, summarizePairs } from "./arena_stats.mjs";

const projectRoot = resolve(import.meta.dirname, "..");
const difficulties = ["easy", "medium", "hard", "ultra"];
const childMode = process.env.LASER_WAR_ARENA_CHILD === "1";
const MOVE_WALL_TIMEOUT_MS = 11_000;
const CHILD_WALL_TIMEOUT_MS = 240_000;
const MAX_ARENA_WORKERS = 2;
const fixtureDirectory = join(projectRoot, "web", "fixtures");
const historicalOpeningFiles = [
  "ultra_choke_46_move_log.json",
  "ultra_freeze_11_move_log.json",
  "ultra_freeze_13_move_log.json",
  "ultra_loss_10_move_log.json",
  "ultra_loss_13_move_log.json",
  "ultra_loss_15_move_log.json",
  "ultra_loss_18_move_log.json",
  "ultra_loss_25_move_log.json",
  "ultra_loss_26_move_log.json",
  "ultra_loss_30_move_log.json",
  "ultra_loss_reversed_28_move_log.json",
  "ultra_root_pruning_31_move_log.json",
  "ultra_slow_14_move_log.json",
];
const executablePaths = [
  "web/ai.js",
  "web/tactics.js",
  "web/endgame.js",
  "web/engine.js",
  "web/exact_routes.js",
  "web/minisat.js",
];
const rulePaths = ["web/engine.js", "web/exact_routes.js", "web/minisat.js"];
const harnessPaths = [
  "scripts/elo_benchmark.mjs",
  "scripts/arena_stats.mjs",
  "scripts/arena_integrity.test.mjs",
  ".github/workflows/pages.yml",
];
let Game;

/** Parse the intentionally small command-line surface for arena runs. */
function parseArguments(argv) {
  const options = {
    pairs: 64,
    maxPlies: 96,
    baselineRef: process.env.CI ? "HEAD^" : "HEAD",
    candidateRef: null,
    candidateAi: null,
    difficulties,
    openingPlies: [0, 2, 4, 6, 8, 10],
    seedOffset: 0,
    pairOffset: 0,
    ultraTime: 300,
    ultraNodes: 50_000,
    resource: "nodes",
    openings: "mixed",
    gate: "nonregression",
    verbose: false,
    auditIdentical: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--pairs") options.pairs = Number(argv[++index]);
    else if (argument === "--max-plies") options.maxPlies = Number(argv[++index]);
    else if (argument === "--baseline-ref") options.baselineRef = argv[++index];
    else if (argument === "--candidate-ref") options.candidateRef = argv[++index];
    else if (argument === "--candidate-ai") options.candidateAi = argv[++index];
    else if (argument === "--difficulties") options.difficulties = argv[++index].split(",");
    else if (argument === "--opening-plies") {
      options.openingPlies = argv[++index].split(",").map(Number);
    }
    else if (argument === "--seed-offset") options.seedOffset = Number(argv[++index]);
    else if (argument === "--pair-offset") options.pairOffset = Number(argv[++index]);
    else if (argument === "--ultra-time") options.ultraTime = Number(argv[++index]);
    else if (argument === "--ultra-nodes") options.ultraNodes = Number(argv[++index]);
    else if (argument === "--resource") options.resource = argv[++index];
    else if (argument === "--openings") options.openings = argv[++index];
    else if (argument === "--gate") options.gate = argv[++index];
    else if (argument === "--verbose") options.verbose = true;
    else if (argument === "--audit-identical") options.auditIdentical = true;
    else throw new Error(`Unknown argument: ${argument}`);
  }
  if (!Number.isInteger(options.pairs) || options.pairs < 1) throw new Error("--pairs must be positive.");
  if (!Number.isInteger(options.maxPlies) || options.maxPlies < 1) {
    throw new Error("--max-plies must be positive.");
  }
  if (!options.difficulties.length || options.difficulties.some(
    (difficulty) => !difficulties.includes(difficulty),
  )) {
    throw new Error("--difficulties must contain easy, medium, hard, and/or ultra.");
  }
  if (!options.openingPlies.length || options.openingPlies.some(
    (plies) => !Number.isInteger(plies) || plies < 0,
  )) {
    throw new Error("--opening-plies must be comma-separated non-negative integers.");
  }
  if (!Number.isInteger(options.seedOffset)) throw new Error("--seed-offset must be an integer.");
  if (!Number.isInteger(options.pairOffset) || options.pairOffset < 0) {
    throw new Error("--pair-offset must be a non-negative integer.");
  }
  if (!Number.isFinite(options.ultraTime) || options.ultraTime < 50) {
    throw new Error("--ultra-time must be at least 50 milliseconds.");
  }
  if (!Number.isInteger(options.ultraNodes) || options.ultraNodes < 500) {
    throw new Error("--ultra-nodes must be at least 500.");
  }
  if (!["nodes", "time"].includes(options.resource)) {
    throw new Error("--resource must be nodes or time.");
  }
  if (!["generated", "historical", "mixed", "confirmation"].includes(options.openings)) {
    throw new Error("--openings must be generated, historical, mixed, or confirmation.");
  }
  if (!["off", "nonregression", "improvement"].includes(options.gate)) {
    throw new Error("--gate must be off, nonregression, or improvement.");
  }
  return options;
}

/** Serialize parsed options for one isolated difficulty process. */
function isolatedArguments(
  options,
  difficulty,
  pairs = options.pairs,
  pairOffset = options.pairOffset,
) {
  const argumentsList = [
    import.meta.filename,
    "--pairs", String(pairs),
    "--max-plies", String(options.maxPlies),
    "--baseline-ref", options.baselineRef,
    "--difficulties", difficulty,
    "--opening-plies", options.openingPlies.join(","),
    "--seed-offset", String(options.seedOffset),
    "--pair-offset", String(pairOffset),
    "--ultra-time", String(options.ultraTime),
    "--ultra-nodes", String(options.ultraNodes),
    "--resource", options.resource,
    "--openings", options.openings,
    "--gate", "off",
  ];
  if (options.candidateRef) argumentsList.push("--candidate-ref", options.candidateRef);
  if (options.candidateAi) argumentsList.push("--candidate-ai", options.candidateAi);
  if (options.auditIdentical) argumentsList.push("--audit-identical");
  if (options.verbose) argumentsList.push("--verbose");
  return argumentsList;
}

/** Run one arena child and capture its structured stdout without sharing SAT memory. */
function runArenaChild(argumentsList) {
  return new Promise((resolveChild, rejectChild) => {
    execFile(
      process.execPath,
      argumentsList,
      {
        cwd: projectRoot,
        encoding: "utf8",
        maxBuffer: 64 * 1024 * 1024,
        timeout: CHILD_WALL_TIMEOUT_MS,
        killSignal: "SIGKILL",
        env: { ...process.env, LASER_WAR_ARENA_CHILD: "1" },
      },
      (error, stdout, stderr) => {
        if (error) {
          rejectChild(new Error(stderr.trim() || error.message));
          return;
        }
        resolveChild(stdout);
      },
    );
  });
}

/** Map jobs through a bounded worker pool so host contention cannot distort runs. */
async function mapConcurrent(values, limit, callback) {
  const results = Array(values.length);
  let next = 0;
  const workers = Array.from(
    { length: Math.min(limit, values.length) },
    async () => {
      while (next < values.length) {
        const index = next;
        next += 1;
        results[index] = await callback(values[index], index);
      }
    },
  );
  await Promise.all(workers);
  return results;
}

/** Freeze tracked and untracked web sources without changing the user's index or refs. */
function snapshotWorkingTree() {
  const temporary = mkdtempSync(join(tmpdir(), "laser-war-arena-index-"));
  const environment = {
    ...process.env,
    GIT_INDEX_FILE: join(temporary, "index"),
    GIT_AUTHOR_NAME: "Laser War Arena",
    GIT_AUTHOR_EMAIL: "arena@invalid",
    GIT_COMMITTER_NAME: "Laser War Arena",
    GIT_COMMITTER_EMAIL: "arena@invalid",
    GIT_AUTHOR_DATE: "2000-01-01T00:00:00Z",
    GIT_COMMITTER_DATE: "2000-01-01T00:00:00Z",
  };
  try {
    execFileSync("git", ["read-tree", "HEAD"], { cwd: projectRoot, env: environment });
    execFileSync("git", ["add", "-A", "--", "web"], {
      cwd: projectRoot,
      env: environment,
    });
    const tree = execFileSync("git", ["write-tree"], {
      cwd: projectRoot,
      env: environment,
      encoding: "utf8",
    }).trim();
    return execFileSync("git", ["commit-tree", tree, "-p", "HEAD"], {
      cwd: projectRoot,
      env: environment,
      encoding: "utf8",
      input: "Immutable arena candidate snapshot\n",
    }).trim();
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

/** Return a deterministic random source so paired games share the same noise. */
function randomSource(initialSeed) {
  let seed = initialSeed >>> 0;
  return () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 2 ** 32;
  };
}

/** Replace one required source construct and fail closed if the adapter no longer matches. */
function replaceRequired(source, pattern, replacement, label) {
  const flags = pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`;
  const matches = [...source.matchAll(new RegExp(pattern.source, flags))];
  if (matches.length !== 1) {
    throw new Error(`Arena adapter expected one ${label}; found ${matches.length}.`);
  }
  return source.replace(pattern, replacement);
}

/** Inject an arena-owned counter into expensive authoritative rule operations. */
function instrumentRules(source) {
  let instrumented = source;
  for (const method of [
    "legalChildren",
    "resolveMove",
    "fireLasers",
    "reachableKingMasksByLaser",
    "jointPathPreserved",
    "jointPathPreservedFast",
    "routeCostsByLaser",
  ]) {
    instrumented = replaceRequired(
      instrumented,
      new RegExp(`(\\n  ${method}\\([^\\n]*\\) \\{)`),
      `$1\n    globalThis.__laserWarArenaCount?.();`,
      `rules operation ${method}`,
    );
  }
  return instrumented;
}

/** Load one AI revision with its complete executable dependency tree. */
async function loadAiRevision(label, bundle, options) {
  const directory = mkdtempSync(join(tmpdir(), `laser-war-${label}-`));
  const source = bundle["web/ai.js"];
  const configuredLimit = Number(source.match(/timeLimit:\s*(\d+)/)?.[1] || 10000);
  const configuredSoft = source.match(
    /const softLimit = latePosition \? (\d+) : tacticalEmergency \? (\d+) : mirrors >= 12 \? (\d+) : (\d+);/,
  )?.slice(1).map(Number) || [configuredLimit, configuredLimit * 0.8, configuredLimit * 0.6, configuredLimit * 0.4];
  const effectiveLimit = options.resource === "nodes" ? 1_000_000_000 : options.ultraTime;
  const timingScale = effectiveLimit / configuredLimit;
  const scaledTiming = configuredSoft.map(
    (milliseconds) => Math.max(50, Math.round(milliseconds * timingScale)),
  );
  const reserve = Math.max(5, Math.round(150 * timingScale));
  let instrumented = replaceRequired(
    source,
    /const ULTRA_PROFILE = \{\s*/,
    (match) => `${match}nodeLimit: ${options.resource === "nodes" ? options.ultraNodes : "Infinity"},\n  `,
    "Ultra profile",
  );
  instrumented = replaceRequired(
    instrumented,
    /timeLimit:\s*\d+/,
    `timeLimit: ${effectiveLimit}`,
    "Ultra hard time limit",
  );
  instrumented = instrumented.replace(
    /\s*if \(this\.nodes >= \(this\.profile\.nodeLimit \?\? Infinity\)\) throw new SearchInterrupted\(\);/,
    "",
  );
  instrumented = replaceRequired(
    instrumented,
    /checkInterrupted\(\) \{\s*/,
    (match) => `${match}if (globalThis.__laserWarArenaOperations() >= (this.profile.nodeLimit ?? Infinity)) throw new SearchInterrupted();\n    `,
    "arena-owned interruption hook",
  );
  instrumented = replaceRequired(
    instrumented,
    /this\.profile\.timeLimit - 150/,
    `this.profile.timeLimit - ${reserve}`,
    "search deadline reserve",
  );
  instrumented = replaceRequired(
    instrumented,
    /const softLimit = latePosition \? \d+ : tacticalEmergency \? \d+ : mirrors >= 12 \? \d+ : \d+;/,
    `const softLimit = latePosition ? ${scaledTiming[0]} : tacticalEmergency ? ${scaledTiming[1]} : mirrors >= 12 ? ${scaledTiming[2]} : ${scaledTiming[3]};`,
    "Ultra soft time policy",
  ).replaceAll("performance.now()", "globalThis.__laserWarArenaNow()");
  for (const path of executablePaths) {
    const name = path.slice("web/".length);
    const contents = path === "web/ai.js"
      ? instrumented
      : path === "web/engine.js"
        ? instrumentRules(bundle[path])
        : bundle[path] || (path === "web/endgame.js" ? "export {};" : null);
    if (contents === null) throw new Error(`Revision bundle is missing ${path}.`);
    writeFileSync(join(directory, name), contents);
  }
  writeFileSync(join(directory, "package.json"), '{"private":true,"type":"module"}\n');
  try {
    const cacheKey = `${Date.now()}-${label}`;
    const ai = await import(`${pathToFileURL(join(directory, "ai.js")).href}?revision=${cacheKey}`);
    const rules = await import(
      `${pathToFileURL(join(directory, "engine.js")).href}?revision=${cacheKey}`
    );
    return { ...ai, Game: rules.Game };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

/** Read one file from a Git revision, returning a fallback when it did not exist yet. */
function revisionFile(reference, path, fallback = "") {
  try {
    return execFileSync("git", ["show", `${reference}:${path}`], {
      cwd: projectRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return fallback;
  }
}

/** Hash every isolated AI support module, not only the top-level dispatcher. */
function contentHash(entries) {
  const hash = createHash("sha256");
  for (const [path, source] of entries) hash.update(path).update("\0").update(source).update("\0");
  return hash.digest("hex").slice(0, 12);
}

/** Hash every executable input in stable path order. */
function bundleHash(bundle) {
  return contentHash(executablePaths.map((path) => [path, bundle[path] || ""]));
}

/** Hash the authoritative rules separately so rule changes cannot contaminate Elo. */
function rulesHash(bundle) {
  return contentHash(rulePaths.map((path) => [
    path,
    (bundle[path] || "").replaceAll(/\?v=[0-9.]+/g, "?v=<version>"),
  ]));
}

/** Build a complete revision bundle from Git or from the candidate working tree. */
function sourceBundle(reference = null, candidateAi = null) {
  const bundle = Object.fromEntries(executablePaths.map((path) => [
    path,
    reference
      ? revisionFile(reference, path)
      : readFileSync(join(projectRoot, path), "utf8"),
  ]));
  if (candidateAi) bundle["web/ai.js"] = readFileSync(resolve(projectRoot, candidateAi), "utf8");
  return bundle;
}

/** Ask one revision to move with deterministic clocks and randomness. */
function chooseMove(revision, player, difficulty, game, state, random) {
  let clock = 0;
  let operations = 0;
  globalThis.__laserWarArenaCount = (weight = 1) => { operations += weight; };
  globalThis.__laserWarArenaOperations = () => operations;
  const clockTick = difficulty === "ultra" ? 0.1 : 5;
  globalThis.__laserWarArenaNow = () => {
    clock += clockTick;
    return clock;
  };
  const started = process.hrtime.bigint();
  const result = player
    ? player(state, difficulty, { random, now: globalThis.__laserWarArenaNow })
    : revision.chooseComputerMove(game, state, difficulty, { random });
  const elapsed = Number(process.hrtime.bigint() - started) / 1e6;
  return { ...result, arenaOperations: operations, wallMilliseconds: elapsed };
}

/** Adjudicate reference-engine failures while failing closed for the candidate. */
function operationalFailure(owner, reason, details) {
  if (owner === "baseline") {
    return {
      ...details,
      score: 1,
      invalid: null,
      forfeit: { owner, reason, error: details.error || null },
      truncated: false,
    };
  }
  return {
    ...details,
    score: null,
    invalid: reason,
    forfeit: null,
  };
}

/** Count shields to keep generated openings quiet and strategically plausible. */
function shieldCount(board) {
  return board.reduce(
    (total, row) => total + row.filter((cell) => cell === "O").length,
    0,
  );
}

/** Build one deterministic quiet opening shared by both games in a pair. */
function generatedOpening(seed, plies) {
  const game = new Game();
  const random = randomSource(seed);
  let state = game.initialState();
  for (let ply = 0; ply < plies; ply += 1) {
    const children = game.legalChildren(state);
    if (!children.length) break;
    const shields = shieldCount(state.board);
    const quiet = children.filter(({ state: child }) => (
      !child.winner && !child.draw && shieldCount(child.board) === shields
    ));
    const pool = quiet.length ? quiet : children.filter(({ state: child }) => !child.winner && !child.draw);
    if (!pool.length) break;
    state = pool[Math.floor(random() * pool.length)].state;
  }
  return state;
}

/** Build a broad exact-legal opening that may include shield damage and live pressure. */
function confirmationOpening(seed, plies) {
  const game = new Game();
  const random = randomSource(seed ^ 0x5bd1e995);
  let state = game.initialState();
  for (let ply = 0; ply < plies; ply += 1) {
    const children = game.legalChildren(state).filter(
      ({ state: child }) => !child.winner && !child.draw,
    );
    if (!children.length) break;
    const tactical = children.filter(({ state: child }) => (
      shieldCount(child.board) < shieldCount(state.board)
      || game.fireLasers(child.board).some((beam) => beam.hitShield || beam.hitKing)
    ));
    const pool = tactical.length && ply % 3 === 2 ? tactical : children;
    state = pool[Math.floor(random() * pool.length)].state;
  }
  return state;
}

const historicalFixtures = historicalOpeningFiles.map((name) => ({
  name,
  source: readFileSync(join(fixtureDirectory, name), "utf8"),
})).map(({ name, source }) => ({
  name,
  source,
  fixture: JSON.parse(source),
}));
const openingBookHash = contentHash(
  historicalFixtures.map(({ name, source }) => [name, source]),
);

/** Replay a real historical prefix as a deterministic arena opening. */
function historicalOpening(seed, plies) {
  const game = new Game();
  const eligible = historicalFixtures.filter(({ fixture }) => fixture.moves.length > plies);
  if (!eligible.length) throw new Error(`No frozen historical opening contains ${plies} plies.`);
  const { name, fixture } = eligible[Math.abs(seed) % eligible.length];
  let state = game.initialState();
  for (const [row, col, mirror] of fixture.moves.slice(0, plies)) {
    const move = { row: row - 1, col: col - 1, mirror };
    if (!game.isLegalMove(state, move)) {
      throw new Error(`Frozen opening ${name} contains an illegal move at ply ${state.board.flat().filter((cell) => cell === "/" || cell === "\\").length + 1}.`);
    }
    state = game.resolveMove(state, move).state;
    if (state.winner || state.draw) throw new Error(`Frozen opening ${name} ends before ply ${plies}.`);
  }
  return { state, sourceId: name };
}

/** Serialize one opening so every arena sample has a reproducible identity. */
function describeOpening(state, source, sourceId, seed, plies) {
  const position = `${state.turn}|${state.board.map((row) => row.join("")).join("")}`;
  return {
    state,
    id: contentHash([["opening", `${source}|${sourceId}|${seed}|${plies}|${position}`]]),
    source,
    sourceId,
    seed,
    plies,
  };
}

/** Select generated, frozen historical, or alternating mixed opening coverage. */
function openingState(seed, plies, source, pair) {
  if (source === "confirmation") {
    return describeOpening(
      confirmationOpening(seed, plies),
      "confirmation",
      `holdout-${seed}`,
      seed,
      plies,
    );
  }
  if (source === "historical" || (source === "mixed" && pair % 2 === 0)) {
    const historical = historicalOpening(seed, plies);
    return describeOpening(historical.state, "historical", historical.sourceId, seed, plies);
  }
  return describeOpening(generatedOpening(seed, plies), "generated", `seed-${seed}`, seed, plies);
}

/** Play one authoritative game and return its result and search telemetry. */
function playGame({
  candidate,
  baseline,
  difficulty,
  candidateSide,
  opening,
  seed,
  maxPlies,
}) {
  const game = new Game();
  let state = structuredClone(opening);
  const random = {
    candidate: randomSource(seed ^ 0x9e3779b9),
    baseline: randomSource(seed ^ 0x9e3779b9),
  };
  const telemetry = {
    candidate: { nodes: 0, operations: 0, wallMilliseconds: 0, moves: 0, moveTimes: [], depths: [] },
    baseline: { nodes: 0, operations: 0, wallMilliseconds: 0, moves: 0, moveTimes: [], depths: [] },
  };
  const candidatePlayer = candidate.createComputerPlayer?.(game) || null;
  const baselinePlayer = baseline.createComputerPlayer?.(game) || null;
  const moves = [];

  for (let ply = 0; ply < maxPlies && !state.winner && !state.draw; ply += 1) {
    const owner = state.turn === candidateSide ? "candidate" : "baseline";
    const revision = owner === "candidate" ? candidate : baseline;
    const player = owner === "candidate" ? candidatePlayer : baselinePlayer;
    let result;
    try {
      result = chooseMove(revision, player, difficulty, game, state, random[owner]);
    } catch (error) {
      const details = error instanceof Error
        ? `${error.name}${error.message ? `: ${error.message}` : ""}${error.stack ? `\n${error.stack}` : ""}`
        : String(error);
      return operationalFailure(owner, "exception", {
        illegal: null,
        exception: owner,
        error: details,
        telemetry,
        moves,
      });
    }
    telemetry[owner].nodes += result.nodes || 0;
    telemetry[owner].operations += result.arenaOperations || 0;
    telemetry[owner].wallMilliseconds += result.wallMilliseconds;
    telemetry[owner].moves += 1;
    telemetry[owner].moveTimes.push(result.wallMilliseconds);
    telemetry[owner].depths.push(result.depth || 0);
    if (result.wallMilliseconds > MOVE_WALL_TIMEOUT_MS) {
      return operationalFailure(owner, "timeout", {
        illegal: null,
        timeout: owner,
        error: `Move exceeded ${MOVE_WALL_TIMEOUT_MS} ms.`,
        telemetry,
        moves,
      });
    }
    if (!result.move || !game.isLegalMove(state, result.move)) {
      return operationalFailure(owner, "illegal-move", {
        illegal: owner,
        telemetry,
        moves,
      });
    }
    moves.push({
      owner,
      side: state.turn,
      move: result.move,
      depth: result.depth,
      score: result.score,
    });
    state = game.resolveMove(state, result.move).state;
  }

  const truncated = !state.winner && !state.draw;
  if (truncated) {
    return {
      score: null,
      invalid: "truncated",
      illegal: null,
      telemetry,
      moves,
      truncated: true,
    };
  }
  const score = state.draw ? 0.5 : state.winner === candidateSide ? 1 : 0;
  return { score, invalid: null, illegal: null, telemetry, moves, truncated: false };
}

/** Convert a bounded score rate to the conventional Elo difference. */
function eloFromScore(scoreRate) {
  const bounded = Math.min(0.99, Math.max(0.01, scoreRate));
  return 400 * Math.log10(bounded / (1 - bounded));
}

/** Calculate a Wilson score interval for wins with draws counted as half. */
function scoreInterval(score, games) {
  const probability = score / games;
  const z = 1.96;
  const denominator = 1 + (z * z) / games;
  const center = (probability + (z * z) / (2 * games)) / denominator;
  const margin = (
    z * Math.sqrt((probability * (1 - probability) + (z * z) / (4 * games)) / games)
  ) / denominator;
  return [Math.max(0.01, center - margin), Math.min(0.99, center + margin)];
}

/** Aggregate telemetry from one completed arena game. */
function addTelemetry(total, gameResult) {
  for (const owner of ["candidate", "baseline"]) {
    total[owner].nodes += gameResult.telemetry[owner].nodes;
    total[owner].operations += gameResult.telemetry[owner].operations;
    total[owner].wallMilliseconds += gameResult.telemetry[owner].wallMilliseconds;
    total[owner].moves += gameResult.telemetry[owner].moves;
    total[owner].moveTimes.push(...gameResult.telemetry[owner].moveTimes);
    total[owner].depths.push(...gameResult.telemetry[owner].depths);
  }
}

/** Return a stable nearest-rank percentile for move-time telemetry. */
function percentile(values, probability) {
  if (!values.length) return 0;
  const ordered = [...values].sort((left, right) => left - right);
  return ordered[Math.min(ordered.length - 1, Math.ceil(probability * ordered.length) - 1)];
}

/** Run color-swapped opening pairs and report pair-aware uncertainty. */
function assessDifficulty(candidate, baseline, difficulty, options) {
  const results = [];
  const pairScores = [];
  const telemetry = {
    candidate: { nodes: 0, operations: 0, wallMilliseconds: 0, moves: 0, moveTimes: [], depths: [] },
    baseline: { nodes: 0, operations: 0, wallMilliseconds: 0, moves: 0, moveTimes: [], depths: [] },
  };
  for (let pair = 0; pair < options.pairs; pair += 1) {
    const globalPair = options.pairOffset + pair;
    const opening = openingState(
      0xa11ce + options.seedOffset + globalPair * 7919,
      options.openingPlies[globalPair % options.openingPlies.length],
      options.openings,
      globalPair,
    );
    if (options.verbose) {
      console.log(
        `pair ${globalPair + 1} · opening ${opening.source}/${opening.sourceId}`
        + ` · ${opening.plies} plies · ${opening.id}`,
      );
    }
    let pairScore = 0;
    let pairValid = true;
    for (const candidateSide of ["top", "bottom"]) {
      const result = playGame({
        candidate,
        baseline,
        difficulty,
        candidateSide,
        opening: opening.state,
        seed: 0xc0ffee + options.seedOffset + globalPair * 104729,
        maxPlies: options.maxPlies,
      });
      results.push(result);
      if (result.score === null) pairValid = false;
      else pairScore += result.score;
      addTelemetry(telemetry, result);
      if (options.verbose) {
        const outcome = result.score === null
          ? `invalid:${result.invalid}`
          : result.score === 1 ? "win" : result.score === 0 ? "loss" : "draw";
        const line = result.moves.map(({ owner, move, depth }) => (
          `${owner === "candidate" ? "C" : "B"}:${move.mirror}R${move.row + 1}C${move.col + 1}@${depth}`
        )).join(" ");
        console.log(
          `  pair ${globalPair + 1} · candidate ${candidateSide} · ${outcome}`
          + `${result.error ? ` · error: ${result.error}` : ""} · ${line}`,
        );
      }
    }
    if (pairValid) pairScores.push(pairScore);
    for (const result of results.slice(-2)) {
      result.opening = { ...opening, state: undefined };
      result.validPair = pairValid;
    }
  }

  const summary = summarizePairs(pairScores);
  const validResults = results.filter((result) => result.validPair);
  const score = validResults.reduce((total, result) => total + result.score, 0);
  const games = validResults.length;
  const wins = validResults.filter((result) => result.score === 1).length;
  const draws = validResults.filter((result) => result.score === 0.5).length;
  const losses = validResults.filter((result) => result.score === 0).length;
  const illegal = results.filter((result) => result.illegal).length;
  const timeouts = {
    candidate: results.filter((result) => result.timeout === "candidate").length,
    baseline: results.filter((result) => result.timeout === "baseline").length,
  };
  const candidateSpeed = telemetry.candidate.wallMilliseconds / Math.max(1, telemetry.candidate.moves);
  const baselineSpeed = telemetry.baseline.wallMilliseconds / Math.max(1, telemetry.baseline.moves);
  const candidateP95 = percentile(telemetry.candidate.moveTimes, 0.95);
  const baselineP95 = percentile(telemetry.baseline.moveTimes, 0.95);
  if (!childMode) {
    console.log(
      `${difficulty.padEnd(6)} ${wins}-${draws}-${losses} · `
      + `${Math.round(summary.elo) >= 0 ? "+" : ""}${Math.round(summary.elo)} Elo `
      + `[${Math.round(summary.lowElo)}, ${Math.round(summary.highElo)}] · `
      + `Ptnml ${summary.pentanomial.join("-")} · `
      + `${candidateSpeed.toFixed(1)} vs ${baselineSpeed.toFixed(1)} ms/move · `
      + `p95 ${candidateP95.toFixed(1)} vs ${baselineP95.toFixed(1)} ms`,
    );
  }
  return {
    difficulty,
    score,
    games,
    wins,
    draws,
    losses,
    illegal,
    timeouts,
    pairScores,
    summary,
    telemetry,
    truncated: results.filter((result) => result.truncated).length,
    invalid: results.filter((result) => result.score === null).map((result) => ({
      reason: result.invalid,
      owner: result.timeout || result.illegal || result.exception || null,
      error: result.error || null,
    })),
    forfeits: results.filter((result) => result.forfeit).map((result) => result.forfeit),
    openings: results.filter((_, index) => index % 2 === 0).map((result) => result.opening),
  };
}

const options = parseArguments(process.argv.slice(2));
if (!childMode) {
  if (!options.candidateRef) options.candidateRef = snapshotWorkingTree();
  console.log(
    `AI arena · isolated difficulty processes · ${options.pairs * 2} games per difficulty · `
    + `${options.resource} budget · ${options.openings} openings`,
  );
  const assessments = [];
  for (const difficulty of options.difficulties) {
    const chunkSize = difficulty === "ultra" ? Math.min(2, options.pairs) : options.pairs;
    const chunks = [];
    const childArguments = [];
    for (let start = 0; start < options.pairs; start += chunkSize) {
      const pairs = Math.min(chunkSize, options.pairs - start);
      childArguments.push(isolatedArguments(
        options,
        difficulty,
        pairs,
        options.pairOffset + start,
      ));
    }
    const outputs = difficulty === "ultra"
      ? await mapConcurrent(childArguments, MAX_ARENA_WORKERS, runArenaChild)
      : childArguments.map((argumentsList) => execFileSync(
        process.execPath,
        argumentsList,
        {
          cwd: projectRoot,
          encoding: "utf8",
          maxBuffer: 64 * 1024 * 1024,
          timeout: CHILD_WALL_TIMEOUT_MS,
          killSignal: "SIGKILL",
          env: { ...process.env, LASER_WAR_ARENA_CHILD: "1" },
        },
      ));
    for (const output of outputs) {
      if (options.verbose) {
        const trace = output.split("\n").filter((line) => !line.startsWith("ARENA_RESULT ")).join("\n").trim();
        if (trace) console.log(trace);
      }
      const resultLine = output.split("\n").find((line) => line.startsWith("ARENA_RESULT "));
      if (!resultLine) throw new Error(`${difficulty} arena child returned no result.`);
      chunks.push(JSON.parse(resultLine.slice("ARENA_RESULT ".length)));
    }
    const sourceManifest = JSON.stringify(chunks[0].sourceHashes);
    if (chunks.some((chunk) => JSON.stringify(chunk.sourceHashes) !== sourceManifest)) {
      throw new Error(`${difficulty} arena chunks did not execute identical source bundles.`);
    }
    const pairScores = chunks.flatMap((chunk) => chunk.pairScores);
    const telemetry = {
      candidate: { nodes: 0, operations: 0, wallMilliseconds: 0, moves: 0, moveTimes: [], depths: [] },
      baseline: { nodes: 0, operations: 0, wallMilliseconds: 0, moves: 0, moveTimes: [], depths: [] },
    };
    for (const chunk of chunks) {
      for (const owner of ["candidate", "baseline"]) {
        for (const field of ["nodes", "operations", "wallMilliseconds", "moves"]) {
          telemetry[owner][field] += chunk.telemetry[owner][field];
        }
        telemetry[owner].moveTimes.push(...chunk.telemetry[owner].moveTimes);
        telemetry[owner].depths.push(...chunk.telemetry[owner].depths);
      }
    }
    const summary = summarizePairs(pairScores);
    const games = pairScores.length * 2;
    const score = pairScores.reduce((total, pairScore) => total + pairScore, 0);
    const wins = chunks.reduce((total, chunk) => total + chunk.wins, 0);
    const draws = chunks.reduce((total, chunk) => total + chunk.draws, 0);
    const losses = games - wins - draws;
    const candidateSpeed = telemetry.candidate.wallMilliseconds / Math.max(1, telemetry.candidate.moves);
    const baselineSpeed = telemetry.baseline.wallMilliseconds / Math.max(1, telemetry.baseline.moves);
    const candidateP95 = percentile(telemetry.candidate.moveTimes, 0.95);
    const baselineP95 = percentile(telemetry.baseline.moveTimes, 0.95);
    console.log(
      `${difficulty.padEnd(6)} ${wins}-${draws}-${losses} · `
      + `${Math.round(summary.elo) >= 0 ? "+" : ""}${Math.round(summary.elo)} Elo `
      + `[${Math.round(summary.lowElo)}, ${Math.round(summary.highElo)}] · `
      + `Ptnml ${summary.pentanomial.join("-")} · `
      + `${candidateSpeed.toFixed(1)} vs ${baselineSpeed.toFixed(1)} ms/move · `
      + `p95 ${candidateP95.toFixed(1)} vs ${baselineP95.toFixed(1)} ms`,
    );
    assessments.push({
      difficulty,
      score,
      games,
      illegal: chunks.reduce((total, chunk) => total + chunk.illegal, 0),
      candidateTimeouts: chunks.reduce(
        (total, chunk) => total + chunk.timeouts.candidate,
        0,
      ),
      invalid: chunks.flatMap((chunk) => chunk.invalid || []),
      forfeits: chunks.flatMap((chunk) => chunk.forfeits || []),
      sourceHashes: chunks.map((chunk) => chunk.sourceHashes),
      truncated: chunks.reduce((total, chunk) => total + chunk.truncated, 0),
      openings: chunks.flatMap((chunk) => chunk.openings || []),
      pairScores,
      summary,
    });
  }
  const aggregate = summarizePairs(assessments.flatMap(({ pairScores }) => pairScores));
  const invalidGames = assessments.reduce(
    (total, assessment) => total + assessment.invalid.length,
    0,
  );
  if (invalidGames) {
    const reasons = assessments.flatMap(({ invalid }) => invalid).reduce(
      (counts, { reason }) => ({ ...counts, [reason]: (counts[reason] || 0) + 1 }),
      {},
    );
    throw new Error(
      `Arena invalidated ${invalidGames} game(s) ${JSON.stringify(reasons)}; `
      + "no Elo claim may use this batch.",
    );
  }
  const baselineForfeits = assessments.reduce(
    (total, assessment) => total + assessment.forfeits.length,
    0,
  );
  if (baselineForfeits) {
    console.log(`Reference forfeits under the production clock: ${baselineForfeits}.`);
  }
  if (options.gate !== "off") {
    const failed = assessments.filter(
      ({ summary }) => !passesArenaGate(summary, options.gate),
    );
    if (failed.length || !passesArenaGate(aggregate, options.gate)) {
      throw new Error(`Candidate failed the ${options.gate} gate.`);
    }
  }
  const openingIds = assessments.flatMap(({ openings }) => openings.map(({ id }) => id));
  console.log(`ARENA_MANIFEST ${JSON.stringify({
    schema: "laser-war-arena-v2",
    createdAt: new Date().toISOString(),
    node: process.version,
    platform: `${process.platform}-${process.arch}`,
    options,
    sourceHashes: assessments.map(({ difficulty, sourceHashes }) => ({
      difficulty,
      hashes: sourceHashes[0],
    })),
    openingCount: openingIds.length,
    openingHash: contentHash(openingIds.map((id, index) => [`${index}`, id])),
    harnessHash: contentHash(harnessPaths.map((path) => [
      path,
      readFileSync(join(projectRoot, path), "utf8"),
    ])),
    openingIds,
    referenceForfeits: assessments.flatMap(({ difficulty, forfeits }) => (
      forfeits.map((forfeit) => ({ difficulty, ...forfeit }))
    )),
    result: aggregate,
  })}`);
} else {
  const candidateBundle = sourceBundle(options.candidateRef, options.candidateAi);
  const baselineBundle = sourceBundle(options.baselineRef);
  const sourceHashes = {
    candidate: bundleHash(candidateBundle),
    baseline: bundleHash(baselineBundle),
    candidateRules: rulesHash(candidateBundle),
    baselineRules: rulesHash(baselineBundle),
    openingBook: openingBookHash,
  };
  if (sourceHashes.candidateRules !== sourceHashes.baselineRules) {
    throw new Error(
      "Candidate and baseline rules differ; test rule changes separately before measuring AI Elo.",
    );
  }
  const [candidate, baseline] = await Promise.all([
    loadAiRevision("candidate", candidateBundle, options),
    loadAiRevision("baseline", baselineBundle, options),
  ]);
  Game = candidate.Game;
  if (options.auditIdentical && sourceHashes.candidate !== sourceHashes.baseline) {
    throw new Error("Identical-engine audit requires matching candidate and baseline sources.");
  }

  if (!childMode) {
    console.log(
      `AI arena · candidate working tree vs ${options.baselineRef} · `
      + `${options.pairs * 2} games per difficulty · ${options.resource} budget · `
      + `${options.openings} openings · ${sourceHashes.candidate}/${sourceHashes.baseline}`,
    );
  }
  const assessments = options.difficulties.map(
    (difficulty) => assessDifficulty(candidate, baseline, difficulty, options),
  );
  if (options.auditIdentical && assessments.some(
    ({ pairScores }) => pairScores.some((score) => score !== 1),
  )) {
    throw new Error("Identical engines produced a non-neutral paired result; arena pairing is unsound.");
  }
  const totalScore = assessments.reduce((total, result) => total + result.score, 0);
  const totalGames = assessments.reduce((total, result) => total + result.pairScores.length * 2, 0);
  const aggregate = summarizePairs(assessments.flatMap((result) => result.pairScores));
  const illegalMoves = assessments.reduce((total, result) => total + result.illegal, 0);
  const candidateTimeouts = assessments.reduce(
    (total, result) => total + result.timeouts.candidate,
    0,
  );
  const invalidGames = assessments.reduce(
    (total, assessment) => total + assessment.invalid.length,
    0,
  );
  if (childMode) {
    const assessment = assessments[0];
    console.log(`ARENA_RESULT ${JSON.stringify({
      ...assessment,
      sourceHashes,
    })}`);
  } else {
    console.log(
      `overall ${totalScore.toFixed(1)}/${totalGames} · `
      + `${Math.round(eloFromScore(totalScore / totalGames)) >= 0 ? "+" : ""}`
      + `${Math.round(eloFromScore(totalScore / totalGames))} Elo`,
    );
  }

  if (!childMode && illegalMoves) {
    throw new Error(`Arena detected ${illegalMoves} illegal AI move(s).`);
  }
  if (!childMode && invalidGames) {
    throw new Error(`Arena invalidated ${invalidGames} game(s); no Elo claim may use this batch.`);
  }
  if (!childMode && options.gate !== "off") {
    const failed = assessments.filter(
      ({ summary }) => !passesArenaGate(summary, options.gate),
    );
    if (failed.length || !passesArenaGate(aggregate, options.gate)) {
      const details = failed.map(({ difficulty, summary }) => (
        `${difficulty} ${(summary.scoreRate * 100).toFixed(1)}% `
        + `[${(summary.low * 100).toFixed(1)}–${(summary.high * 100).toFixed(1)}%]`
      )).join(", ");
      throw new Error(
        `Candidate failed the ${options.gate} gate`
        + `${details ? `: ${details}` : " on the aggregate result"}.`,
      );
    }
  }
}
