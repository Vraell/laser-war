import assert from "node:assert/strict";
import test from "node:test";

import { Game } from "../web/engine.js";
import {
  FEATURE_NAMES,
  assertNoGroupLeakage,
  augmentRows,
  extractFeatures,
  fitMonotoneLogistic,
  rotateAndSwapState,
} from "./eval_learned_value_model.mjs";

test("rotation and color swap preserve every side-relative feature", () => {
  const game = new Game();
  let state = game.initialState();
  state = game.resolveMove(state, { row: 4, col: 1, mirror: "/" }).state;
  state = game.resolveMove(state, { row: 8, col: 1, mirror: "\\" }).state;
  const original = extractFeatures(game, state);
  const rotated = extractFeatures(game, rotateAndSwapState(state));
  assert.deepEqual(rotated, original);
});

test("augmentation twins retain one game-level split group", () => {
  const game = new Game();
  const state = game.initialState();
  const rows = augmentRows(game, [{
    rowId: "g0:p0",
    groupId: "g0",
    partition: "train",
    state,
    target: 0.5,
  }]);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].groupId, rows[1].groupId);
  assert.equal(assertNoGroupLeakage({ train: rows, validation: [], test: [] }), 1);
  assert.throws(
    () => assertNoGroupLeakage({ train: [rows[0]], validation: [rows[1]], test: [] }),
    /leaked/,
  );
});

test("constrained fitting cannot assign a harmful monotonic sign", () => {
  const rows = [];
  for (let group = 0; group < 24; group += 1) {
    const value = (group % 7) - 3;
    rows.push({
      groupId: `g${group}`,
      target: value > 0 ? 1 : value < 0 ? 0 : 0.5,
      features: Object.fromEntries(FEATURE_NAMES.map((name, index) => [
        name,
        index ? (group % 3) - 1 : value,
      ])),
    });
  }
  const model = fitMonotoneLogistic(rows, FEATURE_NAMES, 0.03);
  for (const weight of Object.values(model.raw)) assert.ok(weight >= 0);
  assert.ok(model.raw.shieldBalance > 0);
});

test("complete separation remains finite under monotonic calibration", () => {
  const rows = Array.from({ length: 20 }, (_, index) => ({
    groupId: `separated-${index}`,
    target: index < 10 ? 0 : 1,
    features: { signal: index < 10 ? -10000 : 10000 },
  }));
  const model = fitMonotoneLogistic(rows, ["signal"], 0.000001, { signal: "positive" });
  assert.ok(Number.isFinite(model.intercept));
  assert.ok(Number.isFinite(model.raw.signal));
  assert.ok(model.raw.signal >= 0);
});
