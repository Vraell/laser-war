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
assert.doesNotThrow(() => saveLanguage({ setItem() { throw new Error("blocked"); } }, "en"));
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
  "Victoire des rouges",
);
assert.equal(
  translate("fr", "sideToMove", { side: translate("fr", "top") }),
  "Aux bleus de jouer",
);
assert.equal(translate("en", "localMatchup"), "Red vs Blue");
assert.equal(translate("fr", "localMatchup"), "Rouge contre Bleu");
assert.equal(translate("en", "topKing"), "blue king");
assert.equal(translate("fr", "bottomKing"), "roi rouge");
assert.equal(translate("en", "resultDetail", { difficulty: "Hard", count: "17 moves" }), "Hard · 17 moves");
assert.equal(
  translate("en", "computerMatchup", { difficulty: "Ultra", human: "Blue", computer: "Red" }),
  "You (Blue) vs Ultra AI (Red)",
);
assert.equal(
  translate("fr", "computerMatchup", { difficulty: "Ultra", human: "bleu", computer: "rouge" }),
  "Vous (bleu) contre l'IA Ultra (rouge)",
);
assert.equal(translate("fr", "matchLogTitle"), "LASER WAR · HISTORIQUE");
assert.equal(translate("fr", "ultraSearch"), "Ultra · classement des coups possibles");
assert.equal(
  translate("fr", "computerSearchRecovered"),
  "L'IA a repris la partie avec un coup sûr.",
);
assert.equal(
  translate("en", "ultraSearching", { depth: 4, nodes: "1,284", seconds: "1.7" }),
  "Ultra · depth 4 · 1,284 positions · 1.7s",
);

console.log("Web localization checks passed.");
