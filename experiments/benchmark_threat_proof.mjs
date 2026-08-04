import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { performance } from "node:perf_hooks";

import { Game } from "../web/engine.js";
import { TacticalProofSearch } from "../web/tactics.js";
import {
  ThreatProofNumberSearch,
  ThreatSpaceSearch,
  verifyThreatProof,
  verifyThreatSpaceProof,
} from "./threat_proof_search.mjs";

const root = resolve(import.meta.dirname, "..");
const fixtureDirectory = join(root, "web", "fixtures");
const options = Object.fromEntries(process.argv.slice(2).map((argument) => {
  const [key, value = "true"] = argument.replace(/^--/, "").split("=");
  return [key, value];
}));
const maxNodes = Number(options.nodes || 25_000);
const maxMs = Number(options.ms || 750);
const windows = (options.windows || "1,3,5").split(",").map(Number);

/** Replay a historical prefix with authoritative move validation. */
function replay(game, fixture, plies) {
  let state = game.initialState();
  for (let index = 0; index < plies; index += 1) {
    const [row, col, mirror] = fixture.moves[index];
    state = game.resolveMove(state, { row: row - 1, col: col - 1, mirror }).state;
  }
  return state;
}

/** Load every still-valid decisive history and derive tactical endgame windows. */
function loadCases() {
  const cases = [];
  for (const fixtureName of readdirSync(fixtureDirectory).filter((name) => name.endsWith(".json")).sort()) {
    const fixture = JSON.parse(readFileSync(join(fixtureDirectory, fixtureName), "utf8"));
    const game = new Game();
    let finalState;
    try {
      finalState = replay(game, fixture, fixture.moves.length);
    } catch {
      continue;
    }
    if (!finalState.winner) continue;
    for (const plies of windows) {
      if (fixture.moves.length < plies) continue;
      const state = replay(new Game(), fixture, fixture.moves.length - plies);
      if (state.winner || state.draw || state.turn !== finalState.winner) continue;
      cases.push({ fixtureName, fixture, state, winner: finalState.winner, plies });
    }
  }
  assert.ok(cases.some(({ fixtureName }) => fixtureName === "ultra_loss_13_move_log.json"));
  return cases;
}

/** Run one solver under the common node and wall-clock limits. */
function benchmark(name, createSearch, state, winner, plies) {
  const started = performance.now();
  const search = createSearch(started);
  const result = search.prove(state, winner, plies);
  return { name, elapsed: performance.now() - started, result };
}

const cases = loadCases();
const rows = [];
let verified = 0;
let threatVerified = 0;
for (const tacticalCase of cases) {
  const baselineGame = new Game();
  const prototypeGame = new Game();
  const threatGame = new Game();
  const baselineState = replay(
    baselineGame,
    tacticalCase.fixture,
    tacticalCase.fixture.moves.length - tacticalCase.plies,
  );
  const prototypeState = replay(
    prototypeGame,
    tacticalCase.fixture,
    tacticalCase.fixture.moves.length - tacticalCase.plies,
  );
  const threatState = replay(
    threatGame,
    tacticalCase.fixture,
    tacticalCase.fixture.moves.length - tacticalCase.plies,
  );
  const baseline = benchmark(
    "dfs",
    (started) => new TacticalProofSearch(baselineGame, {
      now: () => performance.now(),
      deadline: started + maxMs,
      maxNodes,
    }),
    baselineState,
    tacticalCase.winner,
    tacticalCase.plies,
  );
  const prototype = benchmark(
    "pn",
    (started) => new ThreatProofNumberSearch(prototypeGame, {
      now: () => performance.now(),
      deadline: started + maxMs,
      maxNodes,
    }),
    prototypeState,
    tacticalCase.winner,
    tacticalCase.plies,
  );
  const threat = benchmark(
    "threat",
    (started) => new ThreatSpaceSearch(threatGame, {
      now: () => performance.now(),
      deadline: started + maxMs,
      maxNodes,
    }),
    threatState,
    tacticalCase.winner,
    tacticalCase.plies,
  );
  if (prototype.result.status === "proven") {
    assert.equal(
      verifyThreatProof(prototypeGame, prototype.result),
      true,
      `${tacticalCase.fixtureName} ${tacticalCase.plies}-ply proof failed independent verification`,
    );
    verified += 1;
  }
  if (threat.result.status === "proven") {
    assert.equal(
      verifyThreatSpaceProof(threatGame, threatState, threat.result, tacticalCase.plies),
      true,
      `${tacticalCase.fixtureName} ${tacticalCase.plies}-ply threat proof failed verification`,
    );
    threatVerified += 1;
  }
  rows.push({
    fixture: tacticalCase.fixtureName.replace(/\.json$/, ""),
    plies: tacticalCase.plies,
    dfs: baseline.result.status,
    dfsNodes: baseline.result.nodes,
    dfsMs: Math.round(baseline.elapsed),
    pn: prototype.result.status,
    pnNodes: prototype.result.nodes,
    pnCreated: prototype.result.created,
    pnMs: Math.round(prototype.elapsed),
    reductions: prototype.result.reducedDefenseNodes,
    threat: threat.result.status,
    threatNodes: threat.result.nodes,
    threatMs: Math.round(threat.elapsed),
  });
}

console.table(rows);
const bothProven = rows.filter((row) => row.dfs === "proven" && row.pn === "proven");
const threatBothProven = rows.filter((row) => row.dfs === "proven" && row.threat === "proven");
const nodeRatio = bothProven.length
  ? bothProven.reduce((total, row) => total + row.dfsNodes / Math.max(1, row.pnNodes), 0) / bothProven.length
  : 0;
const threatNodeRatio = threatBothProven.length
  ? threatBothProven.reduce(
    (total, row) => total + row.dfsNodes / Math.max(1, row.threatNodes),
    0,
  ) / threatBothProven.length
  : 0;
const threatTimeRatio = threatBothProven.filter((row) => row.dfsMs >= 2).length
  ? threatBothProven.filter((row) => row.dfsMs >= 2).reduce(
    (total, row) => total + row.dfsMs / Math.max(1, row.threatMs),
    0,
  ) / threatBothProven.filter((row) => row.dfsMs >= 2).length
  : 0;

/** Prove which replies survive the mate-in-one threat in the newest loss. */
function diagnoseDefense() {
  const fixtureName = "ultra_loss_13_move_log.json";
  const fixture = JSON.parse(readFileSync(join(fixtureDirectory, fixtureName), "utf8"));
  const game = new Game();
  const state = replay(game, fixture, 11);
  const attacker = state.turn === "top" ? "bottom" : "top";
  const results = game.legalChildren(state, true).map(({ move, state: child }) => {
    const search = new ThreatSpaceSearch(game, { maxNodes: 5_000 });
    const result = search.prove(child, attacker, 1);
    return { move, status: result.status, nodes: result.nodes };
  });
  const key = ({ row, col, mirror }) => `R${row + 1}C${col + 1}${mirror}`;
  const losing = results.filter(({ status }) => status === "proven");
  const surviving = results.filter(({ status }) => status !== "proven");
  const played = results.find(({ move }) => key(move) === "R2C2/");
  const knownDefense = results.find(({ move }) => key(move) === "R4C7\\");
  assert.equal(played?.status, "proven", "The logged R2C2/ blunder must concede mate in one.");
  assert.equal(knownDefense?.status, "unknown", "R4C7\\ must survive the immediate threat.");
  return {
    fixture: fixtureName,
    legalReplies: results.length,
    mateInOneReplies: losing.length,
    immediateSurvivors: surviving.length,
    played: { move: key(played.move), status: played.status },
    knownDefense: { move: key(knownDefense.move), status: knownDefense.status },
  };
}

const defense = diagnoseDefense();
const summary = {
  cases: rows.length,
  baselineProven: rows.filter((row) => row.dfs === "proven").length,
  prototypeProven: rows.filter((row) => row.pn === "proven").length,
  threatProven: rows.filter((row) => row.threat === "proven").length,
  verified,
  threatVerified,
  bothProven: bothProven.length,
  meanExpansionRatio: Number(nodeRatio.toFixed(2)),
  meanThreatExpansionRatio: Number(threatNodeRatio.toFixed(2)),
  meanThreatTimeRatio: Number(threatTimeRatio.toFixed(2)),
  maxNodes,
  maxMs,
  defense,
};
console.log(JSON.stringify(summary, null, 2));
