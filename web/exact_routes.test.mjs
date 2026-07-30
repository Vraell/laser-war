import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const output = execFileSync(
  process.execPath,
  [fileURLToPath(new URL("../scripts/route_solver_regression.mjs", import.meta.url))],
  {
    cwd: fileURLToPath(new URL("..", import.meta.url)),
    encoding: "utf8",
    timeout: 8_000,
  },
);

assert.match(
  output,
  /Exact route canonicalization passed · valid witness \+ 48 UNSAT queries/,
);

console.log(output.trim());
