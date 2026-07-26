import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { Game } from "../web/engine.js";

const projectRoot = resolve(import.meta.dirname, "..");
const difficulties = ["easy", "medium", "hard", "ultra"];

/** Parse the intentionally small command-line surface for arena runs. */
function parseArguments(argv) {
  const options = {
    pairs: 4,
    maxPlies: 54,
    baselineRef: process.env.CI ? "HEAD^" : "HEAD",
    difficulties,
    openingPlies: 2,
    seedOffset: 0,
    ultraTime: 300,
    verbose: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--pairs") options.pairs = Number(argv[++index]);
    else if (argument === "--max-plies") options.maxPlies = Number(argv[++index]);
    else if (argument === "--baseline-ref") options.baselineRef = argv[++index];
    else if (argument === "--difficulties") options.difficulties = argv[++index].split(",");
    else if (argument === "--opening-plies") options.openingPlies = Number(argv[++index]);
    else if (argument === "--seed-offset") options.seedOffset = Number(argv[++index]);
    else if (argument === "--ultra-time") options.ultraTime = Number(argv[++index]);
    else if (argument === "--verbose") options.verbose = true;
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
  if (!Number.isInteger(options.openingPlies) || options.openingPlies < 0) {
    throw new Error("--opening-plies must be non-negative.");
  }
  if (!Number.isInteger(options.seedOffset)) throw new Error("--seed-offset must be an integer.");
  if (!Number.isFinite(options.ultraTime) || options.ultraTime < 50) {
    throw new Error("--ultra-time must be at least 50 milliseconds.");
  }
  return options;
}

/** Return a deterministic random source so paired games share the same noise. */
function randomSource(initialSeed) {
  let seed = initialSeed >>> 0;
  return () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 2 ** 32;
  };
}

/** Load one AI revision as an isolated module using the current rules engine. */
async function loadAiRevision(label, source, ultraTime) {
  const directory = mkdtempSync(join(tmpdir(), `laser-war-${label}-`));
  const engineUrl = pathToFileURL(join(projectRoot, "web", "engine.js")).href;
  const timingScale = ultraTime / 8000;
  const scaledTiming = [8000, 6250, 4500, 2750].map(
    (milliseconds) => Math.max(50, Math.round(milliseconds * timingScale)),
  );
  const reserve = Math.max(5, Math.round(150 * timingScale));
  const instrumented = source
    .replace(
      /from\s+["']\.\/engine\.js(?:\?v=[^"']+)?["']/,
      `from ${JSON.stringify(engineUrl)}`,
    )
    .replace(/timeLimit:\s*\d+/, `timeLimit: ${ultraTime}`)
    .replace("this.profile.timeLimit - 150", `this.profile.timeLimit - ${reserve}`)
    .replace(
      /const softLimit = latePosition \? \d+ : tacticalEmergency \? \d+ : mirrors >= 12 \? \d+ : \d+;/,
      `const softLimit = latePosition ? ${scaledTiming[0]} : tacticalEmergency ? ${scaledTiming[1]} : mirrors >= 12 ? ${scaledTiming[2]} : ${scaledTiming[3]};`,
    )
    .replaceAll("performance.now()", "globalThis.__laserWarArenaNow()");
  const modulePath = join(directory, "ai.mjs");
  writeFileSync(modulePath, instrumented);
  try {
    return await import(`${pathToFileURL(modulePath).href}?revision=${Date.now()}-${label}`);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

/** Swap player perspective by rotating the symmetric board and king ownership. */
function stateFromTopPerspective(state) {
  const swapCell = (cell) => (cell === "k" ? "K" : cell === "K" ? "k" : cell);
  return {
    board: [...state.board].reverse().map((row) => [...row].reverse().map(swapCell)),
    turn: state.turn === "top" ? "bottom" : "top",
    winner: state.winner ? (state.winner === "top" ? "bottom" : "top") : null,
    draw: state.draw,
  };
}

/** Rotate a move back from the normalized top-player perspective. */
function rotateMove(move) {
  return move ? { row: 8 - move.row, col: 8 - move.col, mirror: move.mirror } : null;
}

/** Ask one revision to move with deterministic clocks and randomness. */
function chooseMove(revision, player, difficulty, game, state, random) {
  const normalized = state.turn === "top" ? state : stateFromTopPerspective(state);
  let clock = 0;
  globalThis.__laserWarArenaNow = difficulty === "ultra"
    ? () => performance.now()
    : () => {
      clock += 5;
      return clock;
    };
  const started = process.hrtime.bigint();
  const result = player
    ? player(normalized, difficulty, { random, now: globalThis.__laserWarArenaNow })
    : revision.chooseComputerMove(game, normalized, difficulty, { random });
  const elapsed = Number(process.hrtime.bigint() - started) / 1e6;
  return {
    ...result,
    move: state.turn === "top" ? result.move : rotateMove(result.move),
    wallMilliseconds: elapsed,
  };
}

/** Build one deterministic legal opening shared by both games in a pair. */
function openingState(seed, plies) {
  const game = new Game();
  const random = randomSource(seed);
  let state = game.initialState();
  for (let ply = 0; ply < plies; ply += 1) {
    const children = game.legalChildren(state);
    if (!children.length) break;
    state = children[Math.floor(random() * children.length)].state;
  }
  return state;
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
  const random = randomSource(seed);
  const telemetry = {
    candidate: { nodes: 0, wallMilliseconds: 0, moves: 0 },
    baseline: { nodes: 0, wallMilliseconds: 0, moves: 0 },
  };
  const candidatePlayer = candidate.createComputerPlayer?.(game) || null;
  const baselinePlayer = baseline.createComputerPlayer?.(game) || null;
  const moves = [];

  for (let ply = 0; ply < maxPlies && !state.winner && !state.draw; ply += 1) {
    const owner = state.turn === candidateSide ? "candidate" : "baseline";
    const revision = owner === "candidate" ? candidate : baseline;
    const player = owner === "candidate" ? candidatePlayer : baselinePlayer;
    const result = chooseMove(revision, player, difficulty, game, state, random);
    telemetry[owner].nodes += result.nodes || 0;
    telemetry[owner].wallMilliseconds += result.wallMilliseconds;
    telemetry[owner].moves += 1;
    if (!result.move || !game.isLegalMove(state, result.move)) {
      return {
        score: owner === "candidate" ? 0 : 1,
        illegal: owner,
        telemetry,
        moves,
      };
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

  const score = state.draw || !state.winner
    ? 0.5
    : state.winner === candidateSide ? 1 : 0;
  return { score, illegal: null, telemetry, moves };
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
    total[owner].wallMilliseconds += gameResult.telemetry[owner].wallMilliseconds;
    total[owner].moves += gameResult.telemetry[owner].moves;
  }
}

/** Run paired games for one difficulty and print its Elo-style report. */
function assessDifficulty(candidate, baseline, difficulty, options) {
  const results = [];
  const telemetry = {
    candidate: { nodes: 0, wallMilliseconds: 0, moves: 0 },
    baseline: { nodes: 0, wallMilliseconds: 0, moves: 0 },
  };
  for (let pair = 0; pair < options.pairs; pair += 1) {
    const opening = openingState(
      0xa11ce + options.seedOffset + pair * 7919,
      options.openingPlies,
    );
    for (const candidateSide of ["top", "bottom"]) {
      const result = playGame({
        candidate,
        baseline,
        difficulty,
        candidateSide,
        opening,
        seed: 0xc0ffee + options.seedOffset + pair * 104729,
        maxPlies: options.maxPlies,
      });
      results.push(result);
      addTelemetry(telemetry, result);
      if (options.verbose) {
        const outcome = result.score === 1 ? "win" : result.score === 0 ? "loss" : "draw";
        const line = result.moves.map(({ owner, move, depth }) => (
          `${owner === "candidate" ? "C" : "B"}:${move.mirror}R${move.row + 1}C${move.col + 1}@${depth}`
        )).join(" ");
        console.log(`  pair ${pair + 1} · candidate ${candidateSide} · ${outcome} · ${line}`);
      }
    }
  }

  const score = results.reduce((total, result) => total + result.score, 0);
  const games = results.length;
  const wins = results.filter((result) => result.score === 1).length;
  const draws = results.filter((result) => result.score === 0.5).length;
  const losses = games - wins - draws;
  const scoreRate = score / games;
  const [low, high] = scoreInterval(score, games);
  const illegal = results.filter((result) => result.illegal).length;
  const candidateSpeed = telemetry.candidate.wallMilliseconds / Math.max(1, telemetry.candidate.moves);
  const baselineSpeed = telemetry.baseline.wallMilliseconds / Math.max(1, telemetry.baseline.moves);
  console.log(
    `${difficulty.padEnd(6)} ${wins}-${draws}-${losses} · `
    + `${Math.round(eloFromScore(scoreRate)) >= 0 ? "+" : ""}${Math.round(eloFromScore(scoreRate))} Elo `
    + `[${Math.round(eloFromScore(low))}, ${Math.round(eloFromScore(high))}] · `
    + `${candidateSpeed.toFixed(1)} vs ${baselineSpeed.toFixed(1)} ms/move`,
  );
  return { difficulty, score, games, low, high, illegal };
}

const options = parseArguments(process.argv.slice(2));
const candidateSource = readFileSync(join(projectRoot, "web", "ai.js"), "utf8");
const baselineSource = execFileSync(
  "git",
  ["show", `${options.baselineRef}:web/ai.js`],
  { cwd: projectRoot, encoding: "utf8" },
);
const [candidate, baseline] = await Promise.all([
  loadAiRevision("candidate", candidateSource, options.ultraTime),
  loadAiRevision("baseline", baselineSource, options.ultraTime),
]);

console.log(
  `AI arena · candidate working tree vs ${options.baselineRef} · `
  + `${options.pairs * 2} games per difficulty`,
);
const assessments = options.difficulties.map(
  (difficulty) => assessDifficulty(candidate, baseline, difficulty, options),
);
const totalScore = assessments.reduce((total, result) => total + result.score, 0);
const totalGames = assessments.reduce((total, result) => total + result.games, 0);
const [, aggregateHigh] = scoreInterval(totalScore, totalGames);
const illegalMoves = assessments.reduce((total, result) => total + result.illegal, 0);
console.log(
  `overall ${totalScore.toFixed(1)}/${totalGames} · `
  + `${Math.round(eloFromScore(totalScore / totalGames)) >= 0 ? "+" : ""}`
  + `${Math.round(eloFromScore(totalScore / totalGames))} Elo`,
);

if (illegalMoves) {
  throw new Error(`Arena detected ${illegalMoves} illegal AI move(s).`);
}
if (aggregateHigh < 0.5) {
  throw new Error("Candidate is statistically weaker than the baseline.");
}
