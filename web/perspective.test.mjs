import assert from "node:assert/strict";

import {
  BLUE_SIDE,
  RED_SIDE,
  displayPoint,
  logicalSquare,
  opposingSide,
  perspectiveLabels,
} from "./perspective.js";

assert.deepEqual(logicalSquare(2, 7, RED_SIDE), [2, 7]);
assert.deepEqual(logicalSquare(2, 7, BLUE_SIDE), [6, 1]);
assert.deepEqual(displayPoint([125, 850], RED_SIDE), [125, 850]);
assert.deepEqual(displayPoint([125, 850], BLUE_SIDE), [775, 50]);
assert.deepEqual(perspectiveLabels(RED_SIDE), [1, 2, 3, 4, 5, 6, 7, 8, 9]);
assert.deepEqual(perspectiveLabels(BLUE_SIDE), [9, 8, 7, 6, 5, 4, 3, 2, 1]);
assert.equal(opposingSide(RED_SIDE), BLUE_SIDE);
assert.equal(opposingSide(BLUE_SIDE), RED_SIDE);

console.log("Web perspective checks passed.");
