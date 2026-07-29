import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { UltraSearch } from "../web/ai.js";
import { Game } from "../web/engine.js";

const root = resolve(import.meta.dirname, "..");
const fixtureDirectory = join(root, "web", "fixtures");
const fixtureFiles = readdirSync(fixtureDirectory)
  .filter((name) => name.endsWith(".json"))
  .sort();
const PROFILE = {
  timeLimit: Infinity,
  maxDepth: 2,
  rootLimit: 24,
  branchLimits: [24, 16, 10],
  includeForcingRoots: true,
};

/** Replay a fixture prefix through authoritative move validation. */
function replay(game, fixture, plies = fixture.moves.length) {
  let state = game.initialState();
  for (let ply = 0; ply < Math.min(plies, fixture.moves.length); ply += 1) {
    const [row, col, mirror] = fixture.moves[ply];
    const move = { row: row - 1, col: col - 1, mirror };
    assert.ok(game.isLegalMove(state, move), `${fixture.name} has an illegal move at ply ${ply + 1}.`);
    state = game.resolveMove(state, move).state;
    if (state.winner || state.draw) break;
  }
  return state;
}

/** Return fully legal moves that win immediately for the side to move. */
function immediateWins(game, state) {
  return game.legalChildren(state).filter(({ state: child }) => child.winner === state.turn);
}

/** Return whether a selected child allows an immediate opponent win. */
function concedesMateInOne(game, child) {
  return !child.winner && !child.draw && immediateWins(game, child).length > 0;
}

const fixtures = new Map();
let replayed = 0;
for (const fixtureFile of fixtureFiles) {
  const fixture = JSON.parse(readFileSync(join(fixtureDirectory, fixtureFile), "utf8"));
  fixture.name = fixtureFile;
  fixtures.set(fixtureFile, fixture);
  replayed += fixture.moves.length;
}

const cases = [
  {
    name: "take forced mate in one",
    fixture: "ultra_loss_25_move_log.json",
    plies: 24,
    verify(game, state, result) {
      const wins = immediateWins(game, state);
      assert.ok(wins.length > 0);
      assert.equal(game.resolveMove(state, result.move).state.winner, state.turn);
    },
  },
  {
    name: "avoid conceding mate in one",
    fixture: "ultra_loss_25_move_log.json",
    plies: 21,
    verify(game, state, result) {
      const children = game.legalChildren(state);
      assert.ok(children.some(({ state: child }) => !concedesMateInOne(game, child)));
      assert.ok(children.some(({ state: child }) => concedesMateInOne(game, child)));
      assert.equal(concedesMateInOne(game, game.resolveMove(state, result.move).state), false);
    },
  },
  {
    name: "find only surviving defense",
    fixture: "ultra_loss_18_move_log.json",
    plies: 17,
    verify(game, state, result) {
      const opponent = state.turn === "top" ? "bottom" : "top";
      const survivals = game.legalChildren(state)
        .filter(({ state: child }) => child.winner !== opponent);
      assert.equal(survivals.length, 1);
      assert.deepEqual(result.move, survivals[0].move);
    },
  },
];

for (const tacticalCase of cases) {
  const fixture = fixtures.get(tacticalCase.fixture);
  assert.ok(fixture, `Missing tactical fixture ${tacticalCase.fixture}.`);
  const game = new Game();
  const state = replay(game, fixture, tacticalCase.plies);
  const result = new UltraSearch(game, () => 0, PROFILE).choose(state);
  assert.ok(result.move, `${tacticalCase.name}: Ultra returned no move.`);
  assert.ok(game.isLegalMove(state, result.move), `${tacticalCase.name}: Ultra returned an illegal move.`);
  tacticalCase.verify(game, state, result);
}

console.log(
  `Tactical benchmark passed · ${fixtureFiles.length} logs · ${replayed} logged plies · `
  + `${cases.length} critical positions`,
);
