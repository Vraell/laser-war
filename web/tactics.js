/** Raised internally when an optional tactical proof exceeds its time budget. */
class ProofInterrupted extends Error {}

function moveKey(move) {
  return `${move.row},${move.col},${move.mirror}`;
}

function stateKey(state) {
  return `${state.turn}|${state.winner || ""}|${state.draw ? 1 : 0}|${state.board
    .map((row) => row.join(""))
    .join("")}`;
}

/** Prove short forced wins while testing every legal defensive reply. */
export class TacticalProofSearch {
  constructor(game, options = {}) {
    this.game = game;
    this.now = options.now || (() => performance.now());
    this.deadline = options.deadline ?? Infinity;
    this.nodes = 0;
    this.memo = new Map();
  }

  /** Return a sound forced-win certificate, unknown, or timeout. */
  prove(state, winner, maxPlies) {
    this.nodes = 0;
    try {
      const proof = this.proveNode(state, winner, maxPlies);
      return proof
        ? { status: "proven", winner, nodes: this.nodes, ...proof }
        : { status: "unknown", winner, nodes: this.nodes };
    } catch (error) {
      if (!(error instanceof ProofInterrupted)) throw error;
      return { status: "timeout", winner, nodes: this.nodes };
    }
  }

  /** Solve one attacker-exists or defender-for-all proof node. */
  proveNode(state, winner, pliesRemaining) {
    this.checkInterrupted();
    this.nodes += 1;
    if (state.winner) {
      return state.winner === winner
        ? { distance: 0, line: [], replyCounts: [] }
        : null;
    }
    if (state.draw || pliesRemaining === 0) return null;

    const cacheKey = `${winner}|${pliesRemaining}|${stateKey(state)}`;
    if (this.memo.has(cacheKey)) return this.memo.get(cacheKey);
    const attackerTurn = state.turn === winner;
    const children = this.candidateChildren(state, attackerTurn);

    if (attackerTurn) {
      for (const { move, state: child } of children) {
        const continuation = this.proveNode(child, winner, pliesRemaining - 1);
        if (!continuation || !this.game.isLegalMove(state, move)) continue;
        const proof = {
          distance: continuation.distance + 1,
          line: [move, ...continuation.line],
          replyCounts: continuation.replyCounts,
        };
        this.memo.set(cacheKey, proof);
        return proof;
      }
      this.memo.set(cacheKey, null);
      return null;
    }

    let longest = null;
    let legalReplies = 0;
    for (const { move, state: child } of children) {
      const continuation = this.proveNode(child, winner, pliesRemaining - 1);
      if (!continuation) {
        if (this.game.isLegalMove(state, move)) {
          this.memo.set(cacheKey, null);
          return null;
        }
        continue;
      }
      legalReplies += 1;
      if (!longest || continuation.distance > longest.continuation.distance) {
        longest = { move, continuation };
      }
    }
    if (!longest) {
      this.memo.set(cacheKey, null);
      return null;
    }
    const proof = {
      distance: longest.continuation.distance + 1,
      line: [longest.move, ...longest.continuation.line],
      replyCounts: [
        { ply: pliesRemaining, replies: legalReplies },
        ...longest.continuation.replyCounts,
      ],
    };
    this.memo.set(cacheKey, proof);
    return proof;
  }

  /** Use a fast superset for defenses and laser-changing moves for attacks. */
  candidateChildren(state, attackerTurn) {
    let children = this.game.legalChildren(state, false);
    if (attackerTurn) {
      const liveSquares = new Set(
        this.game.fireLasers(state.board)
          .flatMap((beam) => beam.path.map(([row, col]) => `${row},${col}`)),
      );
      children = children.filter(
        ({ move }) => liveSquares.has(`${move.row},${move.col}`),
      );
    }
    return children.sort((left, right) => (
      Number(Boolean(right.state.winner)) - Number(Boolean(left.state.winner))
      || moveKey(left.move).localeCompare(moveKey(right.move))
    ));
  }

  checkInterrupted() {
    if (this.now() >= this.deadline) throw new ProofInterrupted();
  }
}
