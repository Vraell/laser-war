import { BOARD_SIZE, Cell } from "./engine.js?v=0.10.2";

const ULTRA_PROFILE = {
  timeLimit: 6000,
  maxDepth: 10,
  rootLimit: 24,
  branchLimits: [22, 12, 8],
};
const MATE_SCORE = 10_000;

class SearchInterrupted extends Error {}

function moveKey(move) {
  return `${move.row},${move.col},${move.mirror}`;
}

function stateKey(state) {
  return `${state.turn}|${state.winner || ""}|${state.draw ? 1 : 0}|${state.board.map((row) => row.join("")).join("")}`;
}

function scoreForTop(game, state) {
  return state.turn === "top" ? game.evaluate(state) : -game.evaluate(state);
}

/** Choose an Easy, Medium, or Hard move with bounded tactical reply analysis. */
function standardMove(game, state, difficulty, random) {
  const started = performance.now();
  const children = game.legalChildren(state);
  if (!children.length) return { move: null, score: 0, depth: 0, nodes: 0, elapsed: 0 };
  let nodes = children.length;
  const ranked = children.map(({ move, state: child }) => ({
    move,
    state: child,
    score: scoreForTop(game, child),
  })).sort((left, right) => right.score - left.score);

  if (difficulty === "easy") {
    const pool = ranked.slice(0, Math.min(8, ranked.length));
    const picked = pool[Math.floor(random() * pool.length)];
    return { move: picked.move, score: picked.score, depth: 1, nodes, elapsed: performance.now() - started };
  }

  const deadline = started + (difficulty === "hard" ? 500 : 140);
  const minimumCandidates = difficulty === "hard" ? 24 : 6;
  const analyzed = [];
  for (const candidate of ranked) {
    if (candidate.state.winner === "top") {
      return {
        move: candidate.move,
        score: 10000,
        depth: 1,
        nodes,
        elapsed: performance.now() - started,
      };
    }
    if (candidate.state.winner || candidate.state.draw) {
      analyzed.push(candidate);
      continue;
    }
    if (performance.now() >= deadline && analyzed.length >= 1) break;
    let worstReply = Infinity;
    let complete = true;
    const replies = game.legalChildren(candidate.state);
    if (!replies.length) worstReply = 0;
    for (const { state: replyState } of replies) {
      if (performance.now() >= deadline && analyzed.length >= 1) {
        complete = false;
        break;
      }
      nodes += 1;
      worstReply = Math.min(worstReply, scoreForTop(game, replyState));
      if (replyState.winner === "bottom") {
        worstReply = -10000;
        complete = true;
        break;
      }
    }
    if (complete) {
      candidate.score = worstReply;
      analyzed.push(candidate);
    }
    const safeCandidates = analyzed.filter((item) => item.score > -10000).length;
    if (analyzed.length >= minimumCandidates && safeCandidates >= 3) break;
  }

  if (analyzed.length) {
    analyzed.sort((left, right) => right.score - left.score);
    ranked.splice(0, ranked.length, ...analyzed);
  }

  if (difficulty === "hard") {
    const picked = ranked[0];
    return {
      move: picked.move,
      score: picked.score,
      depth: analyzed.length ? 2 : 1,
      nodes,
      elapsed: performance.now() - started,
    };
  }

  if (!analyzed.length) {
    for (const candidate of ranked.slice(0, 3)) {
      const opponentWins = game.legalChildren(candidate.state)
        .some(({ state: replyState }) => replyState.winner === "bottom");
      if (opponentWins) candidate.score = -10000;
    }
    ranked.sort((left, right) => right.score - left.score);
  }

  const poolSize = Math.min(3, ranked.length);
  const picked = ranked[Math.floor(random() * poolSize)];
  return {
    move: picked.move,
    score: picked.score,
    depth: analyzed.length ? 2 : 1,
    nodes,
    elapsed: performance.now() - started,
  };
}

export class UltraSearch {
  /** Initialize caches and timing for one Ultra search. */
  constructor(game, now, profile = ULTRA_PROFILE) {
    this.game = game;
    this.now = now;
    this.profile = profile;
    this.deadline = Infinity;
    this.nodes = 0;
    this.ordering = new Map();
    this.history = new Map();
    this.killers = new Map();
    this.cache = new Map();
    this.childrenCache = new Map();
  }

  /** Choose a move with iterative deepening under the Ultra budget. */
  choose(state) {
    const started = this.now();
    this.deadline = started + this.profile.timeLimit;
    const timing = this.softTiming(state, started);
    const rootKey = stateKey(state);
    const children = this.game.legalChildren(state);
    if (!children.length) return { move: null, score: this.game.evaluate(state), depth: 0, nodes: 0, elapsed: 0 };
    this.childrenCache.set(rootKey, children);

    let bestMove = children[0].move;
    let bestScore = -Infinity;
    let completedDepth = 0;
    for (let depth = 1; depth <= this.profile.maxDepth; depth += 1) {
      const iterationStarted = this.now();
      const configuredDeadline = this.deadline;
      if (depth === 1) this.deadline = Infinity;
      try {
        const result = this.searchRoot(state, depth);
        bestMove = result.move;
        bestScore = result.score;
        completedDepth = depth;
        this.ordering.set(rootKey, moveKey(bestMove));
        const now = this.now();
        const iterationElapsed = now - iterationStarted;
        if (Math.abs(bestScore) >= MATE_SCORE - 100) break;
        if (depth >= 3 && (
          now >= timing.softDeadline
          || (!timing.latePosition
            && now + Math.max(50, iterationElapsed * 1.8) >= timing.softDeadline)
        )) break;
      } catch (error) {
        if (!(error instanceof SearchInterrupted)) throw error;
        break;
      } finally {
        this.deadline = configuredDeadline;
      }
    }
    return {
      move: bestMove,
      score: bestScore,
      depth: completedDepth,
      nodes: this.nodes,
      elapsed: this.now() - started,
    };
  }

  /** Score and rank the root children at one completed depth. */
  searchRoot(state, depth) {
    let alpha = -Infinity;
    const beta = Infinity;
    let children = this.orderedChildren(state, 0);
    if (depth >= 3) children = children.slice(0, this.profile.rootLimit);
    const ranked = [];
    for (const { move, state: child } of children) {
      this.checkInterrupted();
      const score = -this.negamax(child, depth - 1, -beta, -alpha, 1);
      ranked.push({ move, score });
      alpha = Math.max(alpha, score);
    }
    ranked.sort((left, right) => right.score - left.score);
    return ranked[0];
  }

  /** Evaluate a subtree with selective alpha-beta negamax. */
  negamax(state, depth, alpha, beta, ply) {
    this.checkInterrupted();
    this.nodes += 1;
    if (state.winner) {
      const score = this.game.evaluate(state);
      return score > 0 ? score - ply : score + ply;
    }
    if (state.draw) return 0;
    if (depth <= 0) return this.stabilizedEvaluation(state, ply);

    const cacheKey = `${stateKey(state)}|${depth}`;
    if (this.cache.has(cacheKey)) return this.cache.get(cacheKey);

    let children = this.orderedChildren(state, ply);
    if (!children.length) return 0;
    const branchLimit = this.profile.branchLimits[
      Math.min(Math.max(0, ply - 1), this.profile.branchLimits.length - 1)
    ];
    children = children.slice(0, branchLimit);

    let value = -Infinity;
    let bestMove = null;
    let cutoff = false;
    for (const { move, state: child } of children) {
      const score = -this.negamax(child, depth - 1, -beta, -alpha, ply + 1);
      if (score > value) {
        value = score;
        bestMove = move;
      }
      alpha = Math.max(alpha, value);
      if (alpha >= beta) {
        cutoff = true;
        const key = moveKey(move);
        this.history.set(key, (this.history.get(key) || 0) + depth * depth);
        const killers = this.killers.get(ply) || [];
        if (!killers.includes(key)) {
          killers.unshift(key);
          killers.splice(2);
          this.killers.set(ply, killers);
        }
        break;
      }
    }
    if (bestMove) this.ordering.set(stateKey(state), moveKey(bestMove));
    if (!cutoff) this.cache.set(cacheKey, value);
    return value;
  }

  /** Return legal children sorted by tactical search priority. */
  orderedChildren(state, ply = 0) {
    const key = stateKey(state);
    let children = this.childrenCache.get(key);
    if (!children) {
      children = this.game.legalChildren(state);
      this.childrenCache.set(key, children);
    }
    const preferred = this.ordering.get(key);
    const killers = this.killers.get(ply) || [];
    return [...children].sort((left, right) => (
      this.movePriority(state, right.move, right.state, preferred, killers)
      - this.movePriority(state, left.move, left.state, preferred, killers)
    ));
  }

  /** Rank a move for ordering without changing its position value. */
  movePriority(state, move, child, preferred, killers) {
    if (child.winner === state.turn) return 1_000_000;
    if (child.winner) return -1_000_000;
    const terminal = child.draw ? 0 : -this.game.evaluate(child) * 1000;
    let adjacentMirrors = 0;
    for (let row = Math.max(0, move.row - 1); row < Math.min(BOARD_SIZE, move.row + 2); row += 1) {
      for (let col = Math.max(0, move.col - 1); col < Math.min(BOARD_SIZE, move.col + 2); col += 1) {
        if ([Cell.SLASH, Cell.BACKSLASH].includes(state.board[row][col])) adjacentMirrors += 1;
      }
    }
    const key = moveKey(move);
    const killerIndex = killers.indexOf(key);
    return (key === preferred ? 100_000 : 0)
      + (killerIndex >= 0 ? 50_000 - killerIndex * 5_000 : 0)
      + terminal
      + (this.history.get(key) || 0)
      + adjacentMirrors * 20;
  }

  /** Extend exposed-king horizons through all legal tactical evasions. */
  stabilizedEvaluation(state, ply) {
    const score = this.strategicEvaluation(state);
    if (!this.game.fireLasers(state.board).some((beam) => beam.hitKing)) return score;

    const children = this.orderedChildren(state, ply);
    if (!children.length) return 0;
    const opponent = state.turn === "top" ? "bottom" : "top";
    let best = -Infinity;
    for (const { state: child } of children) {
      this.checkInterrupted();
      this.nodes += 1;
      if (child.winner === state.turn) return MATE_SCORE - (ply + 1);
      if (child.winner === opponent) continue;
      const candidate = child.draw ? 0 : -this.strategicEvaluation(child);
      best = Math.max(best, candidate);
    }
    return best === -Infinity ? -MATE_SCORE + (ply + 1) : best;
  }

  /** Score shield shape, live beam pressure, and route resilience. */
  strategicEvaluation(state) {
    let score = this.game.evaluate(state);
    const own = state.turn;
    const opponent = own === "top" ? "bottom" : "top";
    const ownKing = own === "top" ? Cell.TOP_KING : Cell.BOTTOM_KING;
    const opponentKing = own === "top" ? Cell.BOTTOM_KING : Cell.TOP_KING;
    score += this.shieldStructure(state, ownKing) - this.shieldStructure(state, opponentKing);

    const reachable = this.game.reachableKingsByLaser(state.board);
    const attackRoutes = reachable.filter((kings) => kings.has(opponent)).length;
    const exposedRoutes = reachable.filter((kings) => kings.has(own)).length;
    score += (attackRoutes - exposedRoutes) * 18;

    const hitKings = new Set(this.game.fireLasers(state.board).map((beam) => beam.hitKing).filter(Boolean));
    if (hitKings.has(opponent)) score += 240;
    if (hitKings.has(own)) score -= 240;
    return score;
  }

  /** Weight close shields more heavily than loose outer protection. */
  shieldStructure(state, king) {
    let kingPosition = null;
    for (let row = 0; row < BOARD_SIZE && !kingPosition; row += 1) {
      for (let col = 0; col < BOARD_SIZE; col += 1) {
        if (state.board[row][col] === king) {
          kingPosition = [row, col];
          break;
        }
      }
    }
    if (!kingPosition) return 0;
    let score = 0;
    for (let row = 0; row < BOARD_SIZE; row += 1) {
      for (let col = 0; col < BOARD_SIZE; col += 1) {
        if (state.board[row][col] !== Cell.SHIELD) continue;
        const distance = Math.max(Math.abs(row - kingPosition[0]), Math.abs(col - kingPosition[1]));
        if (distance === 1) score += 18;
        else if (distance === 2) score += 6;
      }
    }
    return score;
  }

  /** Abort once the configured search deadline is reached. */
  checkInterrupted() {
    if (this.now() >= this.deadline) throw new SearchInterrupted();
  }

  /** Set a phase-aware think target below the absolute search deadline. */
  softTiming(state, started) {
    const mirrors = state.board.flat().filter((cell) => [Cell.SLASH, Cell.BACKSLASH].includes(cell)).length;
    const latePosition = mirrors >= 31;
    const softLimit = latePosition ? 6000 : mirrors >= 12 ? 3500 : 2250;
    return {
      latePosition,
      softDeadline: Math.min(this.deadline, started + softLimit),
    };
  }
}

/** Dispatch a computer move search to the requested difficulty profile. */
export function chooseComputerMove(game, state, difficulty = "medium", options = {}) {
  const random = options.random || Math.random;
  const now = options.now || (() => performance.now());
  return difficulty === "ultra"
    ? new UltraSearch(game, now).choose(state)
    : standardMove(game, state, difficulty, random);
}
