import assert from "node:assert/strict";

import { computerWatchdogMs, emergencyComputerResult } from "./ai_recovery.js";
import { Game } from "./engine.js";

const game = new Game();
assert.equal(computerWatchdogMs("ultra"), 11_000);
for (const difficulty of ["easy", "medium", "hard"]) {
  assert.equal(computerWatchdogMs(difficulty), 3_000);
}
const initial = game.initialState();
const redFallback = emergencyComputerResult(game, initial);
assert.ok(redFallback?.move);
assert.equal(game.isLegalMove(initial, redFallback.move), true);

const afterRed = game.resolveMove(initial, redFallback.move).state;
const blueFallback = emergencyComputerResult(game, afterRed);
assert.ok(blueFallback?.move);
assert.equal(game.isLegalMove(afterRed, blueFallback.move), true);
assert.equal(blueFallback.recovered, true);

console.log("AI emergency recovery checks passed.");
