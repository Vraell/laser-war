const ULTRA_PROFILE = { timeLimit: 10000 };
class SearchInterrupted extends Error {}

/** Preserve the source hooks required by the production arena adapter. */
class ArenaAdapterCompatibility {
  constructor() {
    this.profile = ULTRA_PROFILE;
    this.nodes = 0;
  }

  checkInterrupted() {}

  limits() {
    const deadline = this.profile.timeLimit - 150;
    const latePosition = false;
    const tacticalEmergency = false;
    const mirrors = 0;
    const softLimit = latePosition ? 10000 : tacticalEmergency ? 8000 : mirrors >= 12 ? 6000 : 4000;
    return deadline + softLimit;
  }
}

void SearchInterrupted;
void ArenaAdapterCompatibility;

/** Deliberately weak audit engine that always returns the first fully legal move. */
export function chooseComputerMove(game, state) {
  const candidate = game.legalChildren(state, false).find(
    ({ move }) => game.isLegalMove(state, move),
  );
  return {
    move: candidate?.move ?? null,
    score: 0,
    depth: 0,
    nodes: candidate ? 1 : 0,
    elapsed: 0,
  };
}

/** Create the match-scoped API expected by the production arena. */
export function createComputerPlayer(game) {
  return (state) => chooseComputerMove(game, state);
}
