import assert from "node:assert/strict";

import { buildActiveSave } from "./save.js";

const saved = buildActiveSave({
  id: "match-1",
  startedAt: "2026-07-26T12:00:00.000Z",
  gameVersion: "v0.11.13",
  mode: "local",
  difficulty: "medium",
  history: [],
});

assert.equal(saved.gameVersion, "v0.11.13");

console.log("Web save metadata checks passed.");
