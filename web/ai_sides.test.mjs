import assert from "node:assert/strict";

import { chooseComputerMove } from "./ai.js";

function opponentOf(side) {
  return side === "top" ? "bottom" : "top";
}

/** Build a minimal game where each side has one immediate win and one self-loss. */
function objectiveGame(player) {
  const opponent = opponentOf(player);
  const candidates = [
    { index: 0, winner: player, value: 10_000 },
    { index: 1, winner: null, value: 200 },
    { index: 2, winner: null, value: 100 },
    { index: 3, winner: null, value: 50 },
    { index: 4, winner: null, value: 0 },
    { index: 5, winner: null, value: -50 },
    { index: 6, winner: null, value: -100 },
    { index: 7, winner: opponent, value: -10_000 },
  ];
  return {
    isLegalMove() {
      return true;
    },
    legalChildren(state) {
      if (state.kind !== "root") return [];
      return candidates.map(({ index, winner, value }) => ({
        move: { index },
        state: {
          kind: "candidate",
          turn: opponent,
          winner,
          draw: false,
          value,
        },
      }));
    },
    evaluate(state) {
      return state.turn === player ? state.value : -state.value;
    },
  };
}

for (const player of ["top", "bottom"]) {
  for (const difficulty of ["easy", "medium", "hard"]) {
    const result = chooseComputerMove(
      objectiveGame(player),
      { kind: "root", turn: player, winner: null, draw: false },
      difficulty,
      { random: () => 0 },
    );
    assert.equal(
      result.move.index,
      0,
      `${difficulty} must pursue ${player}'s win rather than its opponent's objective`,
    );
  }
}

console.log("Standard AI side-objective checks passed.");
