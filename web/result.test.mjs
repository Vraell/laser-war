import assert from "node:assert/strict";

import { drawDetailKey } from "./result.js";

assert.equal(drawDetailKey({ hitKings: new Set(["top", "bottom"]) }), "drawDetail");
assert.equal(drawDetailKey({ hitKings: new Set() }), "stalemateDetail");
assert.equal(drawDetailKey(null), "stalemateDetail");

console.log("Web result-detail checks passed.");
