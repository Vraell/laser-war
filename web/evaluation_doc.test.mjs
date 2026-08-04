import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { EVALUATION_WEIGHTS } from "./ai.js";

const appSource = readFileSync(new URL("./app.js", import.meta.url), "utf8");
const documentSource = readFileSync(
  new URL("../docs/ULTRA_EVALUATION.tex", import.meta.url),
  "utf8",
);
const version = appSource.match(/const GAME_VERSION = "(v[^"]+)"/)?.[1];
assert.ok(version, "The game version must be readable from app.js.");
assert.equal(
  documentSource.match(/\\newcommand\{\\GameVersion\}\{([^}]+)\}/)?.[1],
  version,
  "The evaluation document must be updated for every game version.",
);

const documentedWeights = {
  mate: "MateScore",
  tempo: "TempoBias",
  ownShield: "OwnShieldWeight",
  opponentShield: "OpponentShieldWeight",
  attackNearestProximity: "AttackNearestWeight",
  dangerNearestProximity: "DangerNearestWeight",
  attackReserveProximity: "AttackReserveWeight",
  dangerReserveProximity: "DangerReserveWeight",
  attackOneMoveRoute: "AttackOneMoveWeight",
  dangerOneMoveRoute: "DangerOneMoveWeight",
  dangerShieldContact: "DangerContactWeight",
  routeLimit: "RouteLimit",
};

for (const [weight, macro] of Object.entries(documentedWeights)) {
  const documented = Number(
    documentSource.match(new RegExp(`\\\\newcommand\\{\\\\${macro}\\}\\{([^}]+)\\}`))?.[1],
  );
  assert.equal(
    documented,
    EVALUATION_WEIGHTS[weight],
    `Documented ${weight} weight must match the live evaluation.`,
  );
}

console.log(`Evaluation document matches ${version} and all published weights.`);
