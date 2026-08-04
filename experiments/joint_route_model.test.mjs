import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { Game } from "../web/engine.js";
import {
  JOINT_ROUTE_PRESETS,
  compatiblePlans,
  jointRouteProfile,
  jointRouteScore,
} from "./joint_route_model.mjs";

const fixture = JSON.parse(readFileSync(
  new URL("../web/fixtures/ultra_loss_13_move_log.json", import.meta.url),
  "utf8",
));

/** Replay one prefix of the short Ultra loss into a fresh game. */
function replay(plies) {
  const game = new Game();
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

/** Score one candidate child with the full experimental route frontier. */
function scoreCandidate(game, state, [row, col, mirror]) {
  const child = game.resolveMove(
    state,
    { row: row - 1, col: col - 1, mirror },
    false,
    false,
  ).state;
  const profile = jointRouteProfile(
    game,
    child.board,
    state.turn,
    JOINT_ROUTE_PRESETS.analysis,
  );
  return { profile, score: jointRouteScore(profile) };
}

test("joint routes reject empty/mirror and opposing-orientation conflicts", () => {
  const square = 1n << 12n;
  const empty = { empty: square, slash: 0n, backslash: 0n, clear: 0n };
  const slash = { empty: 0n, slash: square, backslash: 0n, clear: 0n };
  const backslash = { empty: 0n, slash: 0n, backslash: square, clear: 0n };
  assert.equal(compatiblePlans(empty, slash), false);
  assert.equal(compatiblePlans(slash, backslash), false);
  assert.equal(compatiblePlans(slash, slash), true);
});

test("joint model exposes cheaper coordination without inventing a move-six edge", () => {
  const { game, state } = replay(5);
  const played = scoreCandidate(game, state, [3, 1, "\\"]);
  const defense = scoreCandidate(game, state, [5, 7, "/"]);
  assert.equal(played.profile.race, 0);
  assert.equal(defense.profile.race, 0);
  assert.equal(defense.score, played.score);
  assert.ok(defense.profile.minimumJointActions < played.profile.minimumJointActions);
});

test("joint model separates the mate blunder from the surviving defense", () => {
  const { game, state } = replay(11);
  const blunder = scoreCandidate(game, state, [2, 2, "/"]);
  const defense = scoreCandidate(game, state, [4, 7, "\\"]);
  assert.equal(blunder.profile.dangerTempo, 1);
  assert.ok(defense.profile.dangerTempo > blunder.profile.dangerTempo);
  assert.ok(defense.score > blunder.score);
});
