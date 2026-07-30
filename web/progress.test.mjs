import assert from "node:assert/strict";

import {
  loadProgress,
  recordResult,
  recoverUltraProgress,
  saveProgress,
} from "./progress.js";

class MemoryStorage {
  constructor() {
    this.values = new Map();
  }

  getItem(key) {
    return this.values.get(key) ?? null;
  }

  setItem(key, value) {
    this.values.set(key, value);
  }
}

const storage = new MemoryStorage();
const progress = loadProgress(storage);
assert.equal(progress.ultraUnlocked, false);
assert.equal(recordResult(progress, { mode: "local", difficulty: "hard", winner: "bottom" }), false);
assert.equal(recordResult(progress, { mode: "computer", difficulty: "medium", winner: "bottom" }), false);
assert.equal(recordResult(progress, { mode: "computer", difficulty: "hard", winner: "top" }), false);
assert.equal(recordResult(progress, { mode: "computer", difficulty: "hard", winner: "bottom" }), true);
assert.equal(progress.ultraUnlocked, true);
const blueProgress = { ultraUnlocked: false };
assert.equal(recordResult(blueProgress, {
  mode: "computer",
  difficulty: "hard",
  winner: "top",
  humanSide: "top",
}), true);
saveProgress(storage, progress);
assert.equal(loadProgress(storage).ultraUnlocked, true);
storage.setItem("laser-war.progress.v1", JSON.stringify({ version: 999, ultraUnlocked: true }));
assert.equal(loadProgress(storage).ultraUnlocked, true);

const recovered = { ultraUnlocked: false };
assert.equal(recoverUltraProgress(recovered, { version: 2, difficulty: "ultra" }), true);
assert.equal(recovered.ultraUnlocked, true);
assert.equal(recoverUltraProgress(recovered, { version: 2, difficulty: "ultra" }), false);
assert.equal(recoverUltraProgress({ ultraUnlocked: false }, { difficulty: "hard" }), false);

console.log("Web progress checks passed.");
