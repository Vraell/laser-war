import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { routePressureScore } from "../web/ai.js";
import { Game } from "../web/engine.js";
import {
  JOINT_ROUTE_PRESETS,
  jointRouteProfile,
  jointRouteScore,
} from "../experiments/joint_route_model.mjs";

const projectRoot = resolve(import.meta.dirname, "..");
const fixturePath = resolve(projectRoot, "web/fixtures/ultra_loss_13_move_log.json");
const fixture = JSON.parse(readFileSync(fixturePath, "utf8"));
const game = new Game();

/** Replay an exact fixture prefix without spending time on the exact route solver. */
function replay(plies) {
  let state = game.initialState();
  for (const [row, col, mirror] of fixture.moves.slice(0, plies)) {
    state = game.resolveMove(
      state,
      { row: row - 1, col: col - 1, mirror },
      false,
      false,
    ).state;
  }
  return state;
}

/** Resolve one named candidate and calculate old and experimental route signals. */
function inspectCandidate(state, label, oneBasedMove, options = JOINT_ROUTE_PRESETS.analysis) {
  const [row, col, mirror] = oneBasedMove;
  const move = { row: row - 1, col: col - 1, mirror };
  const child = game.resolveMove(state, move, false, false).state;
  const own = state.turn;
  const opponent = own === "top" ? "bottom" : "top";
  const independentCosts = game.routeCostsByLaser(child.board);
  const profile = jointRouteProfile(game, child.board, own, options);
  return {
    label,
    move: `${mirror} R${row}C${col}`,
    independentScore: routePressureScore(independentCosts, own, opponent),
    independentCosts,
    jointScore: jointRouteScore(profile),
    ...profile,
  };
}

/** Rank one known candidate against every fully legal move using the compact model. */
function rankCandidate(state, oneBasedMove) {
  const [targetRow, targetCol, targetMirror] = oneBasedMove;
  const ranked = game.legalChildren(state).map(({ move, state: child }) => {
    const profile = jointRouteProfile(
      game,
      child.board,
      state.turn,
      JOINT_ROUTE_PRESETS.search,
    );
    return {
      move,
      score: jointRouteScore(profile),
    };
  }).sort((left, right) => right.score - left.score);
  const index = ranked.findIndex(({ move }) => (
    move.row === targetRow - 1
    && move.col === targetCol - 1
    && move.mirror === targetMirror
  ));
  return {
    rank: index + 1,
    total: ranked.length,
    score: ranked[index]?.score,
    best: ranked.slice(0, 3).map(({ move, score }) => (
      `${move.mirror} R${move.row + 1}C${move.col + 1} (${score})`
    )),
  };
}

/** Print a compact comparison table suited to repeatable experiment reports. */
function printComparison(title, rows) {
  console.log(`\n${title}`);
  console.table(rows.map((row) => ({
    candidate: `${row.label} ${row.move}`,
    independent: row.independentScore,
    joint: row.jointScore,
    attack: row.attackTempo,
    danger: row.dangerTempo,
    race: row.race,
    assignments: row.assignmentCosts.map((cost) => Number.isFinite(cost) ? cost : "-").join("/"),
    redundancy: `${row.attackRedundancy}/${row.dangerRedundancy}`,
    pairs: row.compatiblePairs.join("/"),
    expanded: row.expanded,
    ms: row.milliseconds.toFixed(2),
  })));
  for (const row of rows) {
    console.log(
      `${row.label}: independent routes ${JSON.stringify(row.independentCosts)}, `
      + `enumerated ${row.routeCounts.map((counts) => counts.join("/")).join(" | ")}`,
    );
  }
}

const moveSixState = replay(5);
printComparison("Move 6: independent route score ties the played move and stronger counter", [
  inspectCandidate(moveSixState, "played", [3, 1, "\\"]),
  inspectCandidate(moveSixState, "analysis defense", [5, 7, "/"]),
]);
for (const [label, move] of [["played", [3, 1, "\\"]], ["analysis defense", [5, 7, "/"]]]) {
  const ranking = rankCandidate(moveSixState, move);
  console.log(`Move 6 ${label}: compact rank ${ranking.rank}/${ranking.total}; top ${ranking.best.join(", ")}`);
}

const moveTwelveState = replay(11);
printComparison("Move 12: mate-conceding move versus surviving defense", [
  inspectCandidate(moveTwelveState, "played blunder", [2, 2, "/"]),
  inspectCandidate(moveTwelveState, "surviving defense", [4, 7, "\\"]),
]);
for (const [label, move] of [["played blunder", [2, 2, "/"]], ["surviving defense", [4, 7, "\\"]]]) {
  const ranking = rankCandidate(moveTwelveState, move);
  console.log(`Move 12 ${label}: compact rank ${ranking.rank}/${ranking.total}; top ${ranking.best.join(", ")}`);
}

const fixtureDirectory = resolve(projectRoot, "web/fixtures");
const benchmarkBoards = readdirSync(fixtureDirectory)
  .filter((name) => name.endsWith(".json"))
  .map((name) => JSON.parse(readFileSync(resolve(fixtureDirectory, name), "utf8")))
  .filter((data) => Array.isArray(data.moves) && data.moves.length)
  .map((data) => {
    const fixtureGame = new Game();
    let state = fixtureGame.initialState();
    for (const [row, col, mirror] of data.moves.slice(0, -1)) {
      state = fixtureGame.resolveMove(
        state,
        { row: row - 1, col: col - 1, mirror },
        false,
        false,
      ).state;
      if (state.winner || state.draw) break;
    }
    return { game: fixtureGame, board: state.board, perspective: state.turn };
  });
let exactAgreement = 0;
let individualAgreement = 0;
let individualChecks = 0;
for (const item of benchmarkBoards) {
  const profile = jointRouteProfile(
    item.game,
    item.board,
    item.perspective,
    JOINT_ROUTE_PRESETS.analysis,
  );
  const exactAvailable = item.game.jointPathsAvailable(item.board);
  if (exactAvailable === (profile.assignmentFlexibility > 0)) exactAgreement += 1;
  const independent = item.game.routeCostsByLaser(item.board);
  for (let laser = 0; laser < 2; laser += 1) {
    for (const target of ["top", "bottom"]) {
      if (
        independent[laser][target] === undefined
        || independent[laser][target] > JOINT_ROUTE_PRESETS.analysis.maxActions
      ) continue;
      individualChecks += 1;
      if (profile.individualCosts[laser][target] === independent[laser][target]) {
        individualAgreement += 1;
      }
    }
  }
}
console.log(
  `\nInvariant audit · exact joint availability ${exactAgreement}/${benchmarkBoards.length}; `
  + `individual shortest costs ${individualAgreement}/${individualChecks}.`,
);
for (const item of benchmarkBoards) {
  jointRouteProfile(item.game, item.board, item.perspective, JOINT_ROUTE_PRESETS.search);
}
const samples = [];
for (let run = 0; run < 7; run += 1) {
  const started = performance.now();
  for (const item of benchmarkBoards) {
    jointRouteProfile(item.game, item.board, item.perspective, JOINT_ROUTE_PRESETS.search);
  }
  samples.push((performance.now() - started) / benchmarkBoards.length);
}
samples.sort((a, b) => a - b);
console.log(
  `\nCompact runtime · median ${samples[Math.floor(samples.length / 2)].toFixed(2)} ms/position `
  + `across ${benchmarkBoards.length} historical positions `
  + `(range ${samples[0].toFixed(2)}-${samples.at(-1).toFixed(2)} ms).`,
);
