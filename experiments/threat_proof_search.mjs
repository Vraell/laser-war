import { BOARD_SIZE } from "../web/engine.js";

const INFINITY = 1_000_000_000;

class SearchInterrupted extends Error {}

function moveKey(move) {
  return ((move.row * BOARD_SIZE + move.col) * 2) + Number(move.mirror === "\\");
}

function cappedSum(values) {
  let total = 0;
  for (const value of values) {
    if (value >= INFINITY || total >= INFINITY - value) return INFINITY;
    total += value;
  }
  return total;
}

/** Return the empty squares where a newly placed mirror can alter this volley. */
function liveVolleyMask(game, state) {
  const mask = new Uint8Array(BOARD_SIZE * BOARD_SIZE);
  for (const beam of game.fireLasers(state.board)) {
    for (const [row, col] of beam.path) mask[row * BOARD_SIZE + col] = 1;
  }
  return mask;
}

/** Report whether the current unchanged volley strikes the requested king. */
function kingIsExposed(game, state, player) {
  return game.fireLasers(state.board).some((beam) => beam.hitKing === player);
}

function stateKey(state) {
  return `${state.turn}|${state.winner || ""}|${state.draw ? 1 : 0}|${state.board
    .map((row) => row.join(""))
    .join("")}`;
}

/** Build an unresolved, proven, or disproven AND/OR node. */
function createNode(state, winner, pliesRemaining, parent = null, move = null) {
  const node = {
    state,
    parent,
    move,
    pliesRemaining,
    type: state.turn === winner ? "or" : "and",
    expanded: false,
    children: [],
    reducedDefense: false,
    omittedRepliesAreWins: false,
    edgeValidated: parent === null,
    proof: 1,
    disproof: 1,
  };
  if (node.edgeValidated && (state.winner || state.draw || pliesRemaining === 0)) {
    node.expanded = true;
    if (state.winner === winner) {
      node.proof = 0;
      node.disproof = INFINITY;
    } else {
      node.proof = INFINITY;
      node.disproof = 0;
    }
  }
  return node;
}

/** Experimental best-first proof-number search for forcing laser sequences. */
export class ThreatProofNumberSearch {
  constructor(game, options = {}) {
    this.game = game;
    this.now = options.now || (() => performance.now());
    this.deadline = options.deadline ?? Infinity;
    this.maxNodes = options.maxNodes ?? Infinity;
    this.attackerMoves = options.attackerMoves || "destructive-threats";
    this.nodes = 0;
    this.created = 0;
    this.legalCandidates = 0;
    this.reducedDefenseNodes = 0;
    this.root = null;
  }

  /** Search for a sound forced win inside the selected attacker move space. */
  prove(state, winner, maxPlies) {
    this.nodes = 0;
    this.created = 1;
    this.legalCandidates = 0;
    this.reducedDefenseNodes = 0;
    this.root = createNode(state, winner, maxPlies);
    let interrupted = false;
    try {
      while (this.root.proof !== 0 && this.root.disproof !== 0) {
        this.checkInterrupted();
        const leaf = this.mostProvingNode(this.root);
        this.expand(leaf, winner);
        this.updateAncestors(leaf);
      }
    } catch (error) {
      if (!(error instanceof SearchInterrupted)) throw error;
      interrupted = true;
    }

    const common = {
      winner,
      nodes: this.nodes,
      created: this.created,
      legalCandidates: this.legalCandidates,
      reducedDefenseNodes: this.reducedDefenseNodes,
    };
    if (this.root.proof === 0) {
      const principal = this.principalProof(this.root);
      return {
        status: "proven",
        ...common,
        distance: principal.distance,
        line: principal.line,
        root: this.root,
      };
    }
    return {
      status: interrupted ? "timeout" : "unknown",
      ...common,
      root: this.root,
    };
  }

  /** Descend through proof/disproof minima to the leaf that controls the root. */
  mostProvingNode(node) {
    let current = node;
    while (current.expanded && current.children.length && current.proof && current.disproof) {
      const metric = current.type === "or" ? "proof" : "disproof";
      let best = current.children[0];
      for (let index = 1; index < current.children.length; index += 1) {
        const child = current.children[index];
        if (child[metric] < best[metric]) best = child;
      }
      current = best;
    }
    return current;
  }

  /** Expand one leaf with exact legal children and the exposed-king reduction. */
  expand(node, winner) {
    this.checkInterrupted();
    if (node.expanded) return;
    this.nodes += 1;

    if (!node.edgeValidated) {
      try {
        node.state = this.game.resolveMove(node.parent.state, node.move, false, true).state;
        node.edgeValidated = true;
      } catch {
        node.expanded = true;
        if (node.parent.type === "or") {
          node.proof = INFINITY;
          node.disproof = 0;
        } else {
          node.proof = 0;
          node.disproof = INFINITY;
        }
        return;
      }
      if (node.state.winner || node.state.draw || node.pliesRemaining === 0) {
        node.expanded = true;
        if (node.state.winner === winner) {
          node.proof = 0;
          node.disproof = INFINITY;
        } else {
          node.proof = INFINITY;
          node.disproof = 0;
        }
        return;
      }
    }
    node.expanded = true;

    const attackerTurn = node.type === "or";
    const exposedDefense = !attackerTurn
      && kingIsExposed(this.game, node.state, node.state.turn)
      && !kingIsExposed(this.game, node.state, winner);
    const mask = (!attackerTurn || ["live-volley", "direct-threats", "destructive-threats"].includes(this.attackerMoves))
      ? liveVolleyMask(this.game, node.state)
      : null;
    node.reducedDefense = exposedDefense;
    if (exposedDefense) this.reducedDefenseNodes += 1;

    const candidates = [];
    for (const move of this.game.pseudoMoves(node.state)) {
      this.checkInterrupted();
      const onVolley = !mask || mask[move.row * BOARD_SIZE + move.col];
      if (
        attackerTurn
        && ["live-volley", "direct-threats", "destructive-threats"].includes(this.attackerMoves)
        && !onVolley
      ) continue;
      if (exposedDefense && !onVolley) continue;
      try {
        const outcome = this.game.resolveMove(node.state, move, false, false);
        if (attackerTurn && ["direct-threats", "destructive-threats"].includes(this.attackerMoves)) {
          const defender = winner === "top" ? "bottom" : "top";
          const createsThreat = outcome.state.winner === winner
            || (!outcome.state.winner && kingIsExposed(this.game, outcome.state, defender))
            || (this.attackerMoves === "destructive-threats" && outcome.destroyed.length > 0);
          if (!createsThreat) continue;
        }
        this.legalCandidates += 1;
        candidates.push({ move, outcome });
      } catch {
        // Even the relaxed path checks reject geometry that cannot be repaired.
      }
    }

    candidates.sort((left, right) => (
      Number(right.outcome.state.winner === winner)
      - Number(left.outcome.state.winner === winner)
      || Number(Boolean(right.outcome.state.winner))
      - Number(Boolean(left.outcome.state.winner))
      || right.outcome.destroyed.length - left.outcome.destroyed.length
      || moveKey(left.move) - moveKey(right.move)
    ));
    node.children = candidates.map(({ move, outcome }) => (
      createNode(outcome.state, winner, node.pliesRemaining - 1, node, move)
    ));
    this.created += node.children.length;

    if (!node.children.length && exposedDefense && this.game.hasAnyLegalMove(node.state)) {
      node.omittedRepliesAreWins = true;
    }
    this.recompute(node);
  }

  /** Recompute proof numbers from children without changing solved semantics. */
  recompute(node) {
    if (!node.expanded || (node.state.winner || node.state.draw || node.pliesRemaining === 0)) return;
    if (!node.children.length) {
      if (node.type === "and" && node.omittedRepliesAreWins) {
        node.proof = 0;
        node.disproof = INFINITY;
      } else {
        node.proof = INFINITY;
        node.disproof = 0;
      }
      return;
    }
    if (node.type === "or") {
      node.proof = Math.min(...node.children.map((child) => child.proof));
      node.disproof = cappedSum(node.children.map((child) => child.disproof));
    } else {
      node.proof = cappedSum(node.children.map((child) => child.proof));
      node.disproof = Math.min(...node.children.map((child) => child.disproof));
    }
  }

  /** Propagate a changed proof number to the root. */
  updateAncestors(node) {
    let current = node;
    while (current) {
      const previousProof = current.proof;
      const previousDisproof = current.disproof;
      this.recompute(current);
      if (current === node || current.proof !== previousProof || current.disproof !== previousDisproof) {
        current = current.parent;
      } else {
        break;
      }
    }
  }

  /** Extract the shortest attack and longest defense line from a solved proof tree. */
  principalProof(node) {
    if (node.state.winner) return { distance: 0, line: [] };
    const proven = node.children.filter((child) => child.proof === 0);
    if (!proven.length) return { distance: 1, line: [] };
    const continuations = proven.map((child) => ({
      child,
      proof: this.principalProof(child),
    }));
    continuations.sort((left, right) => (
      node.type === "or"
        ? left.proof.distance - right.proof.distance
        : right.proof.distance - left.proof.distance
    ));
    const selected = continuations[0];
    return {
      distance: selected.proof.distance + 1,
      line: [selected.child.move, ...selected.proof.line],
    };
  }

  /** Abort before a partial expansion can be mistaken for a proof. */
  checkInterrupted() {
    if (this.nodes >= this.maxNodes || this.now() >= this.deadline) {
      throw new SearchInterrupted();
    }
  }
}

/** Compact threat-space DFS using the same sound game-specific reductions. */
export class ThreatSpaceSearch {
  constructor(game, options = {}) {
    this.game = game;
    this.now = options.now || (() => performance.now());
    this.deadline = options.deadline ?? Infinity;
    this.maxNodes = options.maxNodes ?? Infinity;
    this.nodes = 0;
    this.memo = new Map();
  }

  /** Prove one destructive forcing sequence and retain its complete certificate. */
  prove(state, winner, maxPlies) {
    this.nodes = 0;
    try {
      const proof = this.proveNode(state, winner, maxPlies);
      return proof
        ? { status: "proven", winner, nodes: this.nodes, ...proof }
        : { status: "unknown", winner, nodes: this.nodes };
    } catch (error) {
      if (!(error instanceof SearchInterrupted)) throw error;
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
        if (!continuation || !this.game.isLegalMove(state, move)) continue;
        const proof = {
          distance: continuation.distance + 1,
          line: [move, ...continuation.line],
          certificate: {
            type: "or",
            move,
            child: continuation.certificate,
          },
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
        if (this.game.isLegalMove(state, move)) {
          this.memo.set(cacheKey, null);
          return null;
        }
        continue;
      }
      if (!this.game.isLegalMove(state, move)) continue;
      replies.push({ move, child: continuation.certificate });
      if (!longest || continuation.distance > longest.continuation.distance) {
        longest = { move, continuation };
      }
    }
    if (!replies.length) {
      if (!reducedDefense || !this.game.hasAnyLegalMove(state)) {
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

  /** Generate destructive attacks or every defense that can change an exposed volley. */
  candidateChildren(state, winner, attackerTurn, reducedDefense) {
    const mask = liveVolleyMask(this.game, state);
    const defender = winner === "top" ? "bottom" : "top";
    const children = [];
    for (const move of this.game.pseudoMoves(state)) {
      this.checkInterrupted();
      const onVolley = mask[move.row * BOARD_SIZE + move.col];
      if (attackerTurn && !onVolley) continue;
      if (reducedDefense && !onVolley) continue;
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
        // Relaxed children form a safe superset until exact legality is needed.
      }
    }
    return children.sort((left, right) => (
      Number(right.state.winner === winner) - Number(left.state.winner === winner)
      || right.destroyed - left.destroyed
      || moveKey(left.move) - moveKey(right.move)
    ));
  }

  /** Stop without caching a partial proof. */
  checkInterrupted() {
    if (this.nodes >= this.maxNodes || this.now() >= this.deadline) {
      throw new SearchInterrupted();
    }
  }
}

/** Independently replay every branch needed by a returned proof certificate. */
export function verifyThreatProof(game, result) {
  if (result.status !== "proven" || !result.root) return false;
  const winner = result.winner;

  function verifyNode(node) {
    if (node.state.winner || node.state.draw || node.pliesRemaining === 0) {
      return node.state.winner === winner;
    }
    const legal = game.legalChildren(node.state, true);
    const byMove = new Map(node.children.map((child) => [moveKey(child.move), child]));
    if (node.type === "or") {
      return legal.some(({ move }) => {
        const child = byMove.get(moveKey(move));
        return child?.proof === 0 && verifyNode(child);
      });
    }
    return legal.length > 0 && legal.every(({ move, state }) => {
      const child = byMove.get(moveKey(move));
      if (child) return child.proof === 0 && verifyNode(child);
      return node.reducedDefense && state.winner === winner;
    });
  }

  return verifyNode(result.root);
}

/** Verify a compact threat-space certificate against all authoritative replies. */
export function verifyThreatSpaceProof(game, state, result, maxPlies) {
  if (result.status !== "proven" || !result.certificate) return false;
  const winner = result.winner;

  function verifyNode(position, pliesRemaining, certificate) {
    if (position.winner || position.draw || pliesRemaining === 0) {
      return position.winner === winner && certificate?.terminal === true;
    }
    if (certificate?.type === "or") {
      try {
        const child = game.resolveMove(position, certificate.move, false, true).state;
        return verifyNode(child, pliesRemaining - 1, certificate.child);
      } catch {
        return false;
      }
    }
    if (certificate?.type !== "and") return false;
    const replies = new Map(certificate.replies.map((reply) => [moveKey(reply.move), reply.child]));
    const legal = game.legalChildren(position, true);
    return legal.length > 0 && legal.every(({ move, state: child }) => {
      const childCertificate = replies.get(moveKey(move));
      if (childCertificate) return verifyNode(child, pliesRemaining - 1, childCertificate);
      return certificate.reducedDefense && child.winner === winner;
    });
  }

  return verifyNode(state, maxPlies, result.certificate);
}
