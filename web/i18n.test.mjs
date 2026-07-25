import assert from "node:assert/strict";

import {
  LANGUAGE_KEY,
  loadLanguage,
  saveLanguage,
  translate,
} from "./i18n.js";

const values = new Map();
const storage = {
  getItem(key) {
    return values.get(key) ?? null;
  },
  setItem(key, value) {
    values.set(key, value);
  },
};

assert.equal(loadLanguage(storage), "en");
saveLanguage(storage, "fr");
assert.equal(values.get(LANGUAGE_KEY), "fr");
assert.equal(loadLanguage(storage), "fr");
assert.equal(translate("fr", "playComputer"), "Jouer contre l'IA");
assert.equal(
  translate("fr", "opponentKingUnreachable"),
  "Ce coup formerait une forteresse autour du roi adverse.",
);
assert.equal(
  translate("fr", "cellLabel", { row: 2, col: 8, cell: "vide", action: "" }),
  "Ligne 2, colonne 8, vide",
);
assert.equal(
  translate("fr", "sideWins", { side: translate("fr", "bottom") }),
  "Le joueur du bas gagne",
);
assert.equal(
  translate("fr", "sideToMove", { side: translate("fr", "top") }),
  "Au tour du joueur du haut",
);
assert.equal(translate("en", "resultDetail", { difficulty: "Hard", count: "17 moves" }), "Hard · 17 moves");
assert.equal(translate("en", "computerMatchup", { difficulty: "Ultra" }), "You vs Ultra AI");
assert.equal(translate("fr", "computerMatchup", { difficulty: "Ultra" }), "Vous contre l'IA Ultra");
assert.equal(translate("fr", "matchLogTitle"), "LASER WAR · HISTORIQUE");
assert.equal(translate("fr", "ultraSearch"), "Ultra · analyse stratégique avancée");

console.log("Web localization checks passed.");
