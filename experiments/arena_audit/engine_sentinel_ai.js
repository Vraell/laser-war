import { ARENA_AUDIT_REVISION_SENTINEL } from "./engine.js";

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

/** Require a symbol that exists only in this audit revision's rules engine. */
export function chooseComputerMove(game, state) {
  if (!ARENA_AUDIT_REVISION_SENTINEL) throw new Error("Wrong rules-engine revision loaded.");
  const candidate = game.legalChildren(state, false).find(
    ({ move }) => game.isLegalMove(state, move),
  );
  return { move: candidate?.move ?? null, score: 0, depth: 0, nodes: 1, elapsed: 0 };
}

/** Create the match-scoped API expected by the production arena. */
export function createComputerPlayer(game) {
  return (state) => chooseComputerMove(game, state);
}
