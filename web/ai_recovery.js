/** Bound every AI difficulty while preserving Ultra's full production budget. */
export function computerWatchdogMs(difficulty) {
  return difficulty === "ultra" ? 11_000 : 3_000;
}

/** Choose the strongest immediately legal move when the AI worker cannot answer. */
export function emergencyComputerResult(game, state) {
  const player = state.turn;
  const ranked = game.legalChildren(state, false).map((child) => {
    let score;
    if (child.state.winner === player) score = 10000;
    else if (child.state.draw) score = 0;
    else if (child.state.winner) score = -10000;
    else score = -game.evaluate(child.state);
    return { ...child, score };
  }).sort((left, right) => right.score - left.score);
  const selected = ranked.find(({ move }) => game.isLegalMove(state, move));
  if (!selected) return null;
  return {
    move: selected.move,
    score: selected.score,
    depth: 1,
    nodes: ranked.length,
    elapsed: 0,
    recovered: true,
  };
}
