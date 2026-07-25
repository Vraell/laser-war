import assert from "node:assert/strict";

import { beamPoints } from "./beam.js";
import { Cell, Game } from "./engine.js";

assert.deepEqual(
  beamPoints({ path: [[4, 7, "E"], [4, 8, "E"]], exited: true }, 0).at(-1),
  [900, 450],
);
assert.deepEqual(
  beamPoints({ path: [[1, 3, "N"], [0, 3, "N"]], exited: true }, 1).at(-1),
  [350, 0],
);
assert.deepEqual(
  beamPoints({ path: [[2, 4, "S"]], exited: false }, 0).at(-1),
  [450, 250],
);
assert.deepEqual(
  beamPoints({ path: [[1, 0, "N"]], exited: true, exitDirection: "W" }, 0).at(-1),
  [0, 150],
);
assert.deepEqual(
  beamPoints({ path: [[7, 5, "S"], [8, 5, "S"]], exited: true }, 1).at(-1),
  [550, 900],
);

const reportedGame = new Game();
let reportedState = reportedGame.initialState();
let reportedOutcome = null;
for (const [row, col, mirror] of [
  [4, 1, "/"], [4, 5, "/"], [4, 7, "\\"], [3, 6, "/"], [0, 1, "/"],
  [3, 1, "\\"], [3, 0, "\\"], [1, 0, "\\"], [3, 2, "/"], [3, 7, "\\"],
]) {
  reportedOutcome = reportedGame.resolveMove(reportedState, { row, col, mirror });
  reportedState = reportedOutcome.state;
}
assert.equal(reportedOutcome.beams[0].exitDirection, "W");
assert.deepEqual(beamPoints(reportedOutcome.beams[0], 0).at(-1), [0, 150]);

const screenshotGame = new Game();
const screenshotState = screenshotGame.initialState();
for (const [row, col] of [[0, 5], [1, 5], [6, 4], [7, 4], [8, 3], [8, 5]]) {
  screenshotState.board[row][col] = Cell.EMPTY;
}
for (const [row, col, mirror] of [
  [0, 0, Cell.SLASH],
  [0, 6, Cell.SLASH],
  [0, 7, Cell.BACKSLASH],
  [1, 6, Cell.SLASH],
  [1, 7, Cell.BACKSLASH],
  [3, 1, Cell.SLASH],
  [3, 7, Cell.SLASH],
  [4, 1, Cell.SLASH],
  [4, 4, Cell.SLASH],
  [4, 7, Cell.BACKSLASH],
  [8, 1, Cell.BACKSLASH],
  [8, 2, Cell.SLASH],
  [8, 6, Cell.BACKSLASH],
  [8, 7, Cell.SLASH],
]) {
  screenshotState.board[row][col] = mirror;
}
const [screenshotBeam] = screenshotGame.fireLasers(screenshotState.board);
assert.equal(screenshotBeam.path.length, 31);
assert.equal(screenshotBeam.hitKing, "bottom");
assert.deepEqual(beamPoints(screenshotBeam, 0).at(-1), [450, 850]);

console.log("Web beam geometry checks passed.");
