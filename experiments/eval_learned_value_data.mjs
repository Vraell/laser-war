import { readdirSync, readFileSync } from "node:fs";
import { basename, resolve } from "node:path";

import { Cell, Game } from "../web/engine.js";
import {
  augmentRows,
  extractFeatures,
  incumbentScore,
  randomSource,
} from "./eval_learned_value_model.mjs";

export const PARTITION_CONFIG = Object.freeze({
  train: { games: 72, seed: 0x19a2f013 },
  validation: { games: 32, seed: 0x6b84d20f },
  test: { games: 40, seed: 0xd5317a91 },
});

/** Pick a varied legal move without consulting the learned candidate. */
export function rolloutMove(game, state, random, exploration = 0.18) {
  const player = state.turn;
  const opponent = player === "top" ? "bottom" : "top";
  const children = game.legalChildren(state);
  if (!children.length) return null;
  const wins = children.filter(({ state: child }) => child.winner === player);
  if (wins.length) return wins[Math.floor(random() * wins.length)];

  const ranked = children.map((item) => {
    const child = item.state;
    let score = child.winner === opponent ? -100000 : -game.evaluate(child);
    const beams = game.fireLasers(child.board);
    score += beams.filter((beam) => beam.hitKing === opponent).length * 260;
    score -= beams.filter((beam) => beam.hitKing === player).length * 260;
    score += random() * 1e-4;
    return { ...item, score };
  }).sort((left, right) => right.score - left.score);

  const safe = ranked.filter(({ state: child }) => child.winner !== opponent);
  const candidates = safe.length ? safe : ranked;
  if (random() < exploration) {
    const width = Math.min(18, candidates.length);
    return candidates[Math.floor(random() * width)];
  }
  const pool = candidates.slice(0, Math.min(6, candidates.length));
  const best = pool[0].score;
  const weights = pool.map(({ score }) => Math.exp(Math.max(-20, (score - best) / 75)));
  let choice = random() * weights.reduce((sum, weight) => sum + weight, 0);
  for (let index = 0; index < pool.length; index += 1) {
    choice -= weights[index];
    if (choice <= 0) return pool[index];
  }
  return pool.at(-1);
}

/** Add symmetry twins and compute incumbent scores on each transformed board. */
function finalizeRows(rows) {
  const game = new Game();
  return augmentRows(game, rows).map((row) => {
    const score = incumbentScore(game, row.state, row.features);
    return {
      ...row,
      incumbentScore: score,
      features: { ...row.features, incumbentScore: score },
    };
  });
}

/** Generate outcome-labelled games from one seed reserved for one partition. */
export function generateSelfPlayPartition(partition, {
  games = PARTITION_CONFIG[partition].games,
  seed = PARTITION_CONFIG[partition].seed,
  maxPlies = 72,
  sampleEvery = 2,
  exploration = 0.18,
  onProgress = () => {},
} = {}) {
  const rawRows = [];
  const outcomes = { top: 0, bottom: 0, draw: 0, unfinished: 0 };
  const started = performance.now();
  for (let gameIndex = 0; gameIndex < games; gameIndex += 1) {
    const game = new Game();
    const gameSeed = (seed + Math.imul(gameIndex + 1, 104729)) >>> 0;
    const random = randomSource(gameSeed);
    const groupId = `selfplay:${partition}:${gameSeed.toString(16)}:${gameIndex}`;
    let state = game.initialState(gameIndex % 2 ? "top" : "bottom");
    const samples = [];
    const phase = gameIndex % sampleEvery;
    let ply = 0;
    for (; ply < maxPlies && !state.winner && !state.draw; ply += 1) {
      if (ply >= 2 && ply % sampleEvery === phase) {
        samples.push({
          rowId: `${groupId}:p${ply}`,
          groupId,
          partition,
          source: "self-play",
          ply,
          state: structuredClone(state),
        });
      }
      const selected = rolloutMove(game, state, random, exploration);
      if (!selected) break;
      state = selected.state;
    }
    const outcome = state.winner || (state.draw ? "draw" : "unfinished");
    outcomes[outcome] += 1;
    for (const sample of samples) {
      rawRows.push({
        ...sample,
        target: outcome === "draw" || outcome === "unfinished"
          ? 0.5
          : Number(outcome === sample.state.turn),
        finalOutcome: outcome,
      });
    }
    onProgress({ partition, complete: gameIndex + 1, games });
  }
  return {
    rows: finalizeRows(rawRows),
    metadata: {
      partition,
      games,
      seed,
      maxPlies,
      sampleEvery,
      exploration,
      outcomes,
      rawRows: rawRows.length,
      augmentedRows: rawRows.length * 2,
      milliseconds: performance.now() - started,
    },
  };
}

/** Normalize historical array and object move encodings. */
function normalizeMove(move) {
  if (Array.isArray(move)) {
    return { row: Number(move[0]) - 1, col: Number(move[1]) - 1, mirror: move[2] };
  }
  return { row: Number(move.row), col: Number(move.col), mirror: move.mirror };
}

/** Assign fixtures to stable complete-game splits without reading their outcomes. */
function fixturePartition(name) {
  let hash = 2166136261;
  for (const character of name) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  const bucket = (hash >>> 0) % 10;
  if (bucket < 6) return "train";
  if (bucket < 8) return "validation";
  return "test";
}

/** Replay complete historical fixtures and preserve invalid/ongoing audit metadata. */
export function loadHistoricalFixtures(projectRoot) {
  const fixtureDirectory = resolve(projectRoot, "web/fixtures");
  const rawByPartition = { train: [], validation: [], test: [] };
  const audit = [];
  for (const name of readdirSync(fixtureDirectory).filter((file) => file.endsWith(".json")).sort()) {
    const data = JSON.parse(readFileSync(resolve(fixtureDirectory, name), "utf8"));
    if (!Array.isArray(data.moves) || !data.moves.length) continue;
    const game = new Game();
    let state = game.initialState();
    const snapshots = [];
    let error = null;
    for (let index = 0; index < data.moves.length; index += 1) {
      if (index >= 2) snapshots.push({ state: structuredClone(state), ply: index });
      try {
        state = game.resolveMove(state, normalizeMove(data.moves[index])).state;
      } catch (caught) {
        error = { ply: index + 1, code: caught.code || "illegal" };
        break;
      }
    }
    const partition = fixturePartition(name);
    const complete = !error && Boolean(state.winner || state.draw);
    audit.push({
      fixture: name,
      partition,
      plies: data.moves.length,
      status: error ? `invalid:${error.ply}:${error.code}` : state.winner || (state.draw ? "draw" : "ongoing"),
      included: complete,
    });
    if (!complete) continue;
    const groupId = `history:${name}`;
    for (const snapshot of snapshots) {
      rawByPartition[partition].push({
        rowId: `${groupId}:p${snapshot.ply}`,
        groupId,
        partition,
        source: "historical-fixture",
        fixture: basename(name),
        ply: snapshot.ply,
        state: snapshot.state,
        target: state.draw ? 0.5 : Number(state.winner === snapshot.state.turn),
        finalOutcome: state.winner || "draw",
      });
    }
  }
  return {
    partitions: Object.fromEntries(
      Object.entries(rawByPartition).map(([name, rows]) => [name, finalizeRows(rows)]),
    ),
    audit,
  };
}

/** Estimate one targeted position from independent stochastic continuations. */
function rolloutLabel(state, seed, rollouts = 3, maxPlies = 64) {
  const player = state.turn;
  let total = 0;
  const outcomes = { win: 0, draw: 0, loss: 0 };
  for (let rollout = 0; rollout < rollouts; rollout += 1) {
    const game = new Game();
    const random = randomSource((seed + Math.imul(rollout + 1, 65537)) >>> 0);
    let current = structuredClone(state);
    for (let ply = 0; ply < maxPlies && !current.winner && !current.draw; ply += 1) {
      const selected = rolloutMove(game, current, random, 0.14);
      if (!selected) break;
      current = selected.state;
    }
    const result = current.draw || !current.winner ? 0.5 : Number(current.winner === player);
    total += result;
    if (result === 1) outcomes.win += 1;
    else if (result === 0) outcomes.loss += 1;
    else outcomes.draw += 1;
  }
  return { target: total / rollouts, rolloutOutcomes: outcomes };
}

/** Prefer states near a permanent one-king laser assignment. */
function dedicatedPriority(features, random) {
  return Math.abs(features.dedicatedLaserBalance) * 100000
    + Math.abs(features.reserveTempo) * 1000
    + Math.abs(features.attackTempo) * 200
    + Math.abs(features.oneMoveRouteBalance) * 80
    + random();
}

/** Generate scarce dedicated-laser examples without crossing source-game splits. */
export function huntDedicatedRows(rows, partition, {
  limit = 12,
  seed = PARTITION_CONFIG[partition].seed ^ 0x51deca7e,
  sourceLimit = 24,
  depthLimit = 3,
  beamWidth = 5,
  rollouts = 3,
  maxPerSource = 2,
  maxMovesPerParent = 32,
} = {}) {
  const random = randomSource(seed);
  const sources = rows.filter((row) => row.augmentation === "original")
    .sort((left, right) => right.ply - left.ply)
    .slice(0, sourceLimit);
  const generated = [];
  const seen = new Set();
  for (const source of sources) {
    if (generated.length >= limit) break;
    const game = new Game();
    let frontier = [source.state];
    let generatedForSource = 0;
    for (let depth = 1; depth <= depthLimit && frontier.length && generated.length < limit; depth += 1) {
      const candidates = [];
      for (const parent of frontier) {
        const moves = [...game.pseudoMoves(parent)];
        for (let index = 0; index < Math.min(maxMovesPerParent, moves.length); index += 1) {
          const swap = index + Math.floor(random() * (moves.length - index));
          [moves[index], moves[swap]] = [moves[swap], moves[index]];
        }
        for (const move of moves.slice(0, maxMovesPerParent)) {
          let fast;
          try {
            fast = game.resolveMove(parent, move, false, false).state;
          } catch {
            continue;
          }
          if (fast.winner || fast.draw) continue;
          const features = extractFeatures(game, fast);
          candidates.push({ move, parent, fast, features, priority: dedicatedPriority(features, random) });
        }
      }
      candidates.sort((left, right) => right.priority - left.priority);
      const exact = [];
      for (const candidate of candidates.slice(0, beamWidth * 2)) {
        let state;
        try {
          state = game.resolveMove(candidate.parent, candidate.move, false, true).state;
        } catch {
          continue;
        }
        const key = `${state.turn}|${game.boardKey(state.board)}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const features = extractFeatures(game, state);
        exact.push({ state, features, priority: dedicatedPriority(features, random) });
        if (
          !features.dedicatedLaserBalance
          || generated.length >= limit
          || generatedForSource >= maxPerSource
        ) continue;
        const labelSeed = (seed ^ Math.imul(generated.length + 1, 99991)) >>> 0;
        const label = rolloutLabel(state, labelSeed, rollouts);
        generated.push({
          rowId: `${source.groupId}:dedicated:${generated.length}`,
          groupId: source.groupId,
          partition,
          source: "targeted-dedicated-laser",
          fixture: source.fixture,
          ply: source.ply + depth,
          state,
          target: label.target,
          finalOutcome: "rollout-label",
          rolloutOutcomes: label.rolloutOutcomes,
        });
        generatedForSource += 1;
      }
      exact.sort((left, right) => right.priority - left.priority);
      frontier = exact.slice(0, beamWidth).map((candidate) => candidate.state);
    }
  }
  return finalizeRows(generated);
}

/** Select explicit rare-state cohorts and compute forced-defense resources. */
export function rareStateCohorts(rows, { forcedDefenseLimit = 24 } = {}) {
  const original = rows.filter((row) => row.augmentation === "original");
  const cohorts = {
    dedicatedLaser: original.filter((row) => row.features.dedicatedLaserBalance !== 0),
    exposedKing: original.filter((row) => row.features.liveKingBalance !== 0),
    shieldCascade: original.filter((row) => row.features.cascadeKingBalance !== 0),
    forcedDefense: [],
  };
  for (const row of cohorts.exposedKing) {
    if (cohorts.forcedDefense.length >= forcedDefenseLimit) break;
    if (row.features.liveKingBalance >= 0) continue;
    const game = new Game();
    const opponent = row.state.turn === "top" ? "bottom" : "top";
    const children = game.legalChildren(row.state);
    const survivals = children.filter(({ state }) => state.winner !== opponent);
    if (survivals.length && survivals.length < children.length) {
      cohorts.forcedDefense.push({
        ...row,
        defenseResources: survivals.length,
        legalResources: children.length,
      });
    }
  }
  return cohorts;
}
