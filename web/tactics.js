/** Raised internally when an optional tactical proof exceeds its time budget. */
class ProofInterrupted extends Error {}

function moveKey(move) {
  return ((move.row * 9 + move.col) * 2) + Number(move.mirror === "\\");
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
    this.maxNodes = options.maxNodes ?? Infinity;
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
      const liveSquares = new Uint8Array(81);
      for (const beam of this.game.fireLasers(state.board)) {
        for (const [row, col] of beam.path) liveSquares[row * 9 + col] = 1;
      }
      children = children.filter(
        ({ move }) => liveSquares[move.row * 9 + move.col],
      );
    }
    return children.sort((left, right) => (
      Number(Boolean(right.state.winner)) - Number(Boolean(left.state.winner))
      || moveKey(left.move) - moveKey(right.move)
    ));
  }

  checkInterrupted() {
    if (this.nodes >= this.maxNodes || this.now() >= this.deadline) throw new ProofInterrupted();
  }
}

/** Mark empty squares where one new mirror can change the current volley. */
function liveVolleyMask(game, state) {
  const mask = new Uint8Array(81);
  for (const beam of game.fireLasers(state.board)) {
    for (const [row, col] of beam.path) mask[row * 9 + col] = 1;
  }
  return mask;
}

/** Return whether the unchanged current volley reaches one player's king. */
function kingIsExposed(game, state, player) {
  return game.fireLasers(state.board).some((beam) => beam.hitKing === player);
}

/** Prove destructive forcing lines while reducing only mathematically forced defenses. */
export class ThreatSpaceSearch {
  constructor(game, options = {}) {
    this.game = game;
    this.now = options.now || (() => performance.now());
    this.deadline = options.deadline ?? Infinity;
    this.maxNodes = options.maxNodes ?? Infinity;
    this.allowExactLegality = options.allowExactLegality !== false;
    this.nodes = 0;
    this.memo = new Map();
  }

  /** Return a sound forcing certificate, unknown, or timeout. */
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

  /** Solve one existential attack or universal defense node. */
  proveNode(state, winner, pliesRemaining) {
    this.checkInterrupted();
    this.nodes += 1;
    if (state.winner) {
      return state.winner === winner
        ? { distance: 0, line: [], certificate: { terminal: true } }
        : null;
    }
    if (state.draw || pliesRemaining === 0) return null;

    const cacheKey = `${winner}|${pliesRemaining}|${stateKey(state)}`;
    if (this.memo.has(cacheKey)) return this.memo.get(cacheKey);
    const attackerTurn = state.turn === winner;
    const reducedDefense = !attackerTurn
      && kingIsExposed(this.game, state, state.turn)
      && !kingIsExposed(this.game, state, winner);
    const children = this.candidateChildren(state, winner, attackerTurn, reducedDefense);

    if (attackerTurn) {
      for (const { move, state: child } of children) {
        const continuation = this.proveNode(child, winner, pliesRemaining - 1);
        if (!continuation || this.childLegality(state, move, child) !== true) continue;
        const proof = {
          distance: continuation.distance + 1,
          line: [move, ...continuation.line],
          certificate: { type: "or", move, child: continuation.certificate },
        };
        this.memo.set(cacheKey, proof);
        return proof;
      }
      this.memo.set(cacheKey, null);
      return null;
    }

    const replies = [];
    let longest = null;
    for (const { move, state: child } of children) {
      const continuation = this.proveNode(child, winner, pliesRemaining - 1);
      if (!continuation) {
        if (this.childLegality(state, move, child) !== false) {
          this.memo.set(cacheKey, null);
          return null;
        }
        continue;
      }
      if (this.childLegality(state, move, child) === false) continue;
      replies.push({ move, child: continuation.certificate });
      if (!longest || continuation.distance > longest.continuation.distance) {
        longest = { move, continuation };
      }
    }
    if (!replies.length) {
      if (!reducedDefense
        || !this.allowExactLegality
        || !this.game.hasAnyLegalMove(state)) {
        this.memo.set(cacheKey, null);
        return null;
      }
      const proof = {
        distance: 1,
        line: [],
        certificate: { type: "and", reducedDefense: true, replies: [] },
      };
      this.memo.set(cacheKey, proof);
      return proof;
    }
    const proof = {
      distance: longest.continuation.distance + 1,
      line: [longest.move, ...longest.continuation.line],
      certificate: { type: "and", reducedDefense, replies },
    };
    this.memo.set(cacheKey, proof);
    return proof;
  }

  /** Generate destructive attacks or every defense that can alter exposed beams. */
  candidateChildren(state, winner, attackerTurn, reducedDefense) {
    const mask = liveVolleyMask(this.game, state);
    const defender = winner === "top" ? "bottom" : "top";
    const children = [];
    for (const move of this.game.pseudoMoves(state)) {
      this.checkInterrupted();
      const onVolley = mask[move.row * 9 + move.col];
      if ((attackerTurn || reducedDefense) && !onVolley) continue;
      try {
        const outcome = this.game.resolveMove(state, move, false, false);
        if (attackerTurn) {
          const destructive = outcome.state.winner === winner
            || outcome.destroyed.length > 0
            || (!outcome.state.winner && kingIsExposed(this.game, outcome.state, defender));
          if (!destructive) continue;
        }
        children.push({ move, state: outcome.state, destroyed: outcome.destroyed.length });
      } catch {
        // Relaxed children remain a safe superset until exact proof validation.
      }
    }
    return children.sort((left, right) => (
      Number(right.state.winner === winner) - Number(left.state.winner === winner)
      || right.destroyed - left.destroyed
      || moveKey(left.move) - moveKey(right.move)
    ));
  }

  /** Return true, false, or null when bounded validation cannot decide legality. */
  childLegality(state, move, child) {
    if (this.game.fastJointPathWitness(child.board)) return true;
    return this.allowExactLegality ? this.game.isLegalMove(state, move) : null;
  }

  /** Abort without treating a partial forcing tree as a proof. */
  checkInterrupted() {
    if (this.nodes >= this.maxNodes || this.now() >= this.deadline) throw new ProofInterrupted();
  }
}
