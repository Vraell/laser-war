import { BOARD_SIZE, Cell } from "./engine.js?v=0.14.0";

export const ExactOutcome = Object.freeze({
  WIN: "win",
  LOSS: "loss",
  DRAW: "draw",
});

const OTHER_SIDE = { top: "bottom", bottom: "top" };

class SearchInterrupted extends Error {}

function oppositeMirror(cell) {
  if (cell === Cell.SLASH) return Cell.BACKSLASH;
  if (cell === Cell.BACKSLASH) return Cell.SLASH;
  return cell;
}

function swapKing(cell) {
  if (cell === Cell.TOP_KING) return Cell.BOTTOM_KING;
  if (cell === Cell.BOTTOM_KING) return Cell.TOP_KING;
  return cell;
}

/** Transform a move through one rule-preserving board symmetry. */
export function transformMove(move, transform) {
  if (!move) return null;
  if (transform === 1) {
    return { row: move.row, col: BOARD_SIZE - 1 - move.col, mirror: oppositeMirror(move.mirror) };
  }
  if (transform === 2) {
    return { row: BOARD_SIZE - 1 - move.row, col: move.col, mirror: oppositeMirror(move.mirror) };
  }
  if (transform === 3) {
    return {
      row: BOARD_SIZE - 1 - move.row,
      col: BOARD_SIZE - 1 - move.col,
      mirror: move.mirror,
    };
  }
  return { ...move };
}

/** Serialize a state after one symmetry while preserving side identities. */
function transformedStateKey(state, transform) {
  const swapSides = transform >= 2;
  let board = "";
  for (let row = 0; row < BOARD_SIZE; row += 1) {
    for (let col = 0; col < BOARD_SIZE; col += 1) {
      let sourceRow = row;
      let sourceCol = col;
      if (transform === 1) sourceCol = BOARD_SIZE - 1 - col;
      else if (transform === 2) sourceRow = BOARD_SIZE - 1 - row;
      else if (transform === 3) {
        sourceRow = BOARD_SIZE - 1 - row;
        sourceCol = BOARD_SIZE - 1 - col;
      }
      let cell = state.board[sourceRow][sourceCol];
      if (transform === 1 || transform === 2) cell = oppositeMirror(cell);
      if (swapSides) cell = swapKing(cell);
      board += cell;
    }
  }
  const turn = swapSides ? OTHER_SIDE[state.turn] : state.turn;
  const winner = swapSides && state.winner ? OTHER_SIDE[state.winner] : state.winner;
  return `${turn}|${winner || ""}|${state.draw ? 1 : 0}|${board}`;
}

/** Return a canonical state key and the symmetry needed to decode its move. */
export function canonicalState(state) {
  let key = transformedStateKey(state, 0);
  let transform = 0;
  for (let candidate = 1; candidate < 4; candidate += 1) {
    const candidateKey = transformedStateKey(state, candidate);
    if (candidateKey < key) {
      key = candidateKey;
      transform = candidate;
    }
  }
  return { key, transform };
}

/** Count the remaining placement squares that determine exact-solver feasibility. */
export function endgameComplexity(game, state) {
  let pseudoMoves = 0;
  for (const _move of game.pseudoMoves(state)) pseudoMoves += 1;
  return { placementSquares: pseudoMoves / 2, pseudoMoves };
}

/** Solve a finite late position exactly or return unknown at a strict boundary. */
export class ExactLateGameSolver {
  constructor(game, options = {}) {
    this.game = game;
    this.tablebase = options.tablebase || new Map();
    this.now = options.now || (() => performance.now());
    this.defaultMaxNodes = options.maxNodes ?? 25_000;
    this.defaultTimeLimit = options.timeLimit ?? 350;
    this.maxEntries = options.maxEntries ?? 100_000;
  }

  /** Solve one root while retaining only exact transposition entries. */
  solve(state, options = {}) {
    this.nodes = 0;
    this.started = this.now();
    this.deadline = this.started + (options.timeLimit ?? this.defaultTimeLimit);
    this.maxNodes = options.maxNodes ?? this.defaultMaxNodes;
    try {
      const proof = this.solveNode(state, 0);
      return { status: "exact", nodes: this.nodes, elapsed: this.now() - this.started, ...proof };
    } catch (error) {
      if (!(error instanceof SearchInterrupted)) throw error;
      return { status: "unknown", nodes: this.nodes, elapsed: this.now() - this.started };
    }
  }

  /** Resolve one full-width minimax node through every authoritative move. */
  solveNode(state, depth) {
    this.checkInterrupted();
    this.nodes += 1;
    const terminal = this.terminalEntry(state);
    if (terminal) return terminal;

    const canonical = canonicalState(state);
    const cached = this.tablebase.get(canonical.key);
    if (cached) return this.decodeEntry(cached, canonical.transform);
    const liveSquares = this.liveSquareMask(state);
    const moves = this.orderedMoves(state, liveSquares);
    const resolved = new Map();

    // Test live-beam moves first; the full pass below still preserves completeness.
    for (const move of moves) {
      if (!liveSquares[move.row * BOARD_SIZE + move.col]) break;
      const child = this.authoritativeChild(state, move);
      resolved.set(this.moveKey(move), child);
      if (child?.winner !== state.turn) continue;
      const result = { outcome: ExactOutcome.WIN, bestMove: move, witnessPlies: 1 };
      this.storeExact(canonical, result);
      return result;
    }

    let legalChildren = 0;
    let drawChoice = null;
    let longestLoss = null;
    for (const move of moves) {
      this.checkInterrupted();
      const key = this.moveKey(move);
      const child = resolved.has(key) ? resolved.get(key) : this.authoritativeChild(state, move);
      if (!child) continue;
      legalChildren += 1;
      const reply = this.solveNode(child, depth + 1);
      if (reply.outcome === ExactOutcome.LOSS) {
        const result = {
          outcome: ExactOutcome.WIN,
          bestMove: move,
          witnessPlies: reply.witnessPlies + 1,
        };
        this.storeExact(canonical, result);
        return result;
      }
      if (reply.outcome === ExactOutcome.DRAW && !drawChoice) {
        drawChoice = { outcome: ExactOutcome.DRAW, bestMove: move, witnessPlies: null };
      }
      if (reply.outcome === ExactOutcome.WIN) {
        const loss = {
          outcome: ExactOutcome.LOSS,
          bestMove: move,
          witnessPlies: reply.witnessPlies + 1,
        };
        if (!longestLoss || loss.witnessPlies > longestLoss.witnessPlies) longestLoss = loss;
      }
    }

    const result = !legalChildren
      ? { outcome: ExactOutcome.DRAW, bestMove: null, witnessPlies: 0 }
      : drawChoice || longestLoss;
    this.storeExact(canonical, result);
    return result;
  }

  /** Resolve one pseudo move and certify the exact compatible-route rule. */
  authoritativeChild(state, move) {
    this.checkInterrupted();
    let child;
    try {
      child = this.game.resolveMove(state, move, false, false).state;
    } catch {
      return null;
    }
    this.checkInterrupted();
    return this.game.jointPathPreserved(state.board, child.board, move) ? child : null;
  }

  /** Order live-volley interventions first without pruning any move. */
  orderedMoves(state, liveSquares) {
    return [...this.game.pseudoMoves(state)].sort((left, right) => (
      liveSquares[right.row * BOARD_SIZE + right.col]
      - liveSquares[left.row * BOARD_SIZE + left.col]
      || left.row - right.row
      || left.col - right.col
      || Number(left.mirror === Cell.BACKSLASH) - Number(right.mirror === Cell.BACKSLASH)
    ));
  }

  /** Mark every square traversed by the current two-laser volley. */
  liveSquareMask(state) {
    const liveSquares = new Uint8Array(BOARD_SIZE * BOARD_SIZE);
    for (const beam of this.game.fireLasers(state.board)) {
      for (const [row, col] of beam.path) liveSquares[row * BOARD_SIZE + col] = 1;
    }
    return liveSquares;
  }

  /** Convert an already terminal state to a side-to-move W/L/D result. */
  terminalEntry(state) {
    if (state.draw) return { outcome: ExactOutcome.DRAW, bestMove: null, witnessPlies: 0 };
    if (!state.winner) return null;
    return {
      outcome: state.winner === state.turn ? ExactOutcome.WIN : ExactOutcome.LOSS,
      bestMove: null,
      witnessPlies: 0,
    };
  }

  /** Store a certified result in canonical coordinates. */
  storeExact(canonical, result) {
    if (!result || this.tablebase.size >= this.maxEntries) return;
    this.tablebase.set(canonical.key, {
      outcome: result.outcome,
      bestMove: transformMove(result.bestMove, canonical.transform),
      witnessPlies: result.witnessPlies,
    });
  }

  /** Decode a canonical tablebase result into caller coordinates. */
  decodeEntry(entry, transform) {
    return { ...entry, bestMove: transformMove(entry.bestMove, transform) };
  }

  /** Abort before a partial subtree can be stored as exact. */
  checkInterrupted() {
    if (this.nodes >= this.maxNodes || this.now() >= this.deadline) throw new SearchInterrupted();
  }

  moveKey(move) {
    return ((move.row * BOARD_SIZE + move.col) * 2) + Number(move.mirror === Cell.BACKSLASH);
  }
}
