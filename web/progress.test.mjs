import assert from "node:assert/strict";

import { loadProgress, recordResult, saveProgress } from "./progress.js";

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
saveProgress(storage, progress);
assert.equal(loadProgress(storage).ultraUnlocked, true);

console.log("Web progress checks passed.");
