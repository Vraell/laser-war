import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { Game } from "../web/engine.js";
import {
  ThreatProofNumberSearch,
  ThreatSpaceSearch,
  verifyThreatProof,
  verifyThreatSpaceProof,
} from "./threat_proof_search.mjs";

const fixtures = join(import.meta.dirname, "..", "web", "fixtures");

function replay(game, fixtureName, plies) {
  const fixture = JSON.parse(readFileSync(join(fixtures, fixtureName), "utf8"));
  let state = game.initialState();
  for (let index = 0; index < plies; index += 1) {
    const [row, col, mirror] = fixture.moves[index];
    state = game.resolveMove(state, { row: row - 1, col: col - 1, mirror }).state;
  }
  return state;
}

test("both experimental solvers prove and verify the historical three-ply attack", () => {
  const fixture = "ultra_loss_15_move_log.json";
  const game = new Game();
  const state = replay(game, fixture, 12);
  const proofNumber = new ThreatProofNumberSearch(game, { maxNodes: 10_000 })
    .prove(state, "bottom", 3);
  const threatSpace = new ThreatSpaceSearch(game, { maxNodes: 10_000 })
    .prove(state, "bottom", 3);
  assert.equal(proofNumber.status, "proven");
  assert.equal(threatSpace.status, "proven");
  assert.equal(verifyThreatProof(game, proofNumber), true);
  assert.equal(verifyThreatSpaceProof(game, state, threatSpace, 3), true);
});
test("the 13-move loss contains mate-in-one blunders and surviving defenses", () => {
  const game = new Game();
  const state = replay(game, "ultra_loss_13_move_log.json", 11);
  const replies = game.legalChildren(state, true);
  const statuses = new Map(replies.map(({ move, state: child }) => {
    const result = new ThreatSpaceSearch(game, { maxNodes: 5_000 }).prove(child, "bottom", 1);
    return [`${move.row},${move.col},${move.mirror}`, result.status];
  }));
  assert.equal(statuses.get("1,1,/"), "proven");
  assert.equal(statuses.get("3,6,\\"), "unknown");
  assert.ok([...statuses.values()].includes("proven"));
  assert.ok([...statuses.values()].includes("unknown"));
});
