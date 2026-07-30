import { BOARD_SIZE, Cell } from "./engine.js?v=0.13.2";
import { TacticalProofSearch } from "./tactics.js?v=0.13.2";

const ULTRA_PROFILE = {
  timeLimit: 10000,
  maxDepth: 12,
  rootLimit: 16,
  branchLimits: [22, 14, 10],
  proofMaxNodes: 0,
};
const MATE_SCORE = 10_000;

class SearchInterrupted extends Error {}

function moveKey(move) {
  return ((move.row * BOARD_SIZE + move.col) * 2) + Number(move.mirror === Cell.BACKSLASH);
}

function scoreForPlayer(game, state, player) {
  return state.turn === player ? game.evaluate(state) : -game.evaluate(state);
}

function signedSquare(value) {
  return value * Math.abs(value);
}

function boundedRouteCost(costs, player) {
  return Math.min(costs[player] ?? 12, 12);
}

/** Score attack tempo and per-laser control from one player's perspective. */
export function routePressureScore(routeCosts, own, opponent) {
  const attackCosts = routeCosts.map(
    (costs) => boundedRouteCost(costs, opponent),
  ).sort((a, b) => a - b);
  const dangerCosts = routeCosts.map(
    (costs) => boundedRouteCost(costs, own),
  ).sort((a, b) => a - b);
  const raceGap = dangerCosts[0] - attackCosts[0];
  const reserveGap = dangerCosts[1] - attackCosts[1];
  const controlGaps = routeCosts.map(
    (costs) => boundedRouteCost(costs, own) - boundedRouteCost(costs, opponent),
  );
  return raceGap * 67
    + reserveGap * 42
    + signedSquare(raceGap) * 28
    + signedSquare(reserveGap) * 18
    + controlGaps.reduce((total, gap) => total + signedSquare(gap), 0) * 8;
}

/** Choose an Easy, Medium, or Hard move with bounded tactical reply analysis. */
function standardMove(game, state, difficulty, random) {
  const started = performance.now();
  const player = state.turn;
  const opponent = player === "top" ? "bottom" : "top";
  const candidateLimit = difficulty === "hard" ? 24 : difficulty === "medium" ? 10 : 8;
  const approximate = game.legalChildren(state, false).map(({ move, state: child }) => ({
    move,
    state: child,
    score: scoreForPlayer(game, child, player),
  })).sort((left, right) => right.score - left.score);
  const ranked = [];
  for (const candidate of approximate) {
    if (game.isLegalMove(state, candidate.move)) ranked.push(candidate);
    if (ranked.length === candidateLimit) break;
  }
  if (!ranked.length) return { move: null, score: 0, depth: 0, nodes: 0, elapsed: 0 };
  let nodes = ranked.length;

  if (difficulty === "easy") {
    const pool = ranked.slice(0, Math.min(8, ranked.length));
    const picked = pool[Math.floor(random() * pool.length)];
    return { move: picked.move, score: picked.score, depth: 1, nodes, elapsed: performance.now() - started };
  }

  const deadline = started + (difficulty === "hard" ? 500 : 140);
  const minimumCandidates = difficulty === "hard" ? 24 : 6;
  const analyzed = [];
  for (const candidate of ranked) {
    if (candidate.state.winner === player) {
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
    let legalReplies = 0;
    const replies = game.legalChildren(candidate.state, false);
    if (!replies.length) worstReply = 0;
    for (const { move: reply, state: replyState } of replies) {
      if (performance.now() >= deadline && analyzed.length >= 1) {
        complete = false;
        break;
      }
      if (!game.isLegalMove(candidate.state, reply)) continue;
      legalReplies += 1;
      nodes += 1;
      worstReply = Math.min(worstReply, scoreForPlayer(game, replyState, player));
      if (replyState.winner === opponent) {
        worstReply = -10000;
        complete = true;
        break;
      }
    }
    if (complete && legalReplies === 0) worstReply = 0;
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
      const opponentWins = game.legalChildren(candidate.state, false)
        .some(({ move: reply, state: replyState }) => (
          replyState.winner === opponent && game.isLegalMove(candidate.state, reply)
        ));
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
  /** Initialize one reusable Ultra search controller. */
  constructor(game, now, profile = ULTRA_PROFILE, onProgress = () => {}, random = () => 0) {
    this.game = game;
    this.now = now;
    this.profile = profile;
    this.onProgress = onProgress;
    this.random = random;
    this.deadline = Infinity;
    this.nodes = 0;
    this.activeDepth = 0;
    this.lastProgressAt = -Infinity;
    this.ordering = new Map();
    this.rootScores = new Map();
    this.history = new Map();
    this.killers = new Map();
    this.cache = new Map();
    this.childrenCache = new Map();
    this.legalityCache = new Map();
    this.fastLegalityCache = new Map();
    this.evaluationCache = new Map();
    this.orderingEvaluationCache = new Map();
    this.forcingCache = new Map();
    this.forcedExposureCache = new Map();
    this.rootSurvivalCache = new Map();
    this.stateKeys = new WeakMap();
    this.shieldMetricsCache = new WeakMap();
    this.bestCompleted = null;
  }

  /** Discard turn-local heuristics so an old root cannot bias a new position. */
  resetForTurn() {
    this.nodes = 0;
    this.activeDepth = 0;
    this.lastProgressAt = -Infinity;
    this.ordering.clear();
    this.rootScores.clear();
    this.history.clear();
    this.killers.clear();
    this.cache.clear();
    this.childrenCache.clear();
    this.legalityCache.clear();
    this.fastLegalityCache.clear();
    this.evaluationCache.clear();
    this.orderingEvaluationCache.clear();
    this.forcingCache.clear();
    this.forcedExposureCache.clear();
    this.rootSurvivalCache.clear();
    this.stateKeys = new WeakMap();
    this.shieldMetricsCache = new WeakMap();
    this.bestCompleted = null;
  }

  /** Choose a move with iterative deepening under the Ultra budget. */
  choose(state) {
    this.resetForTurn();
    const started = this.now();
    this.deadline = started + Math.max(50, this.profile.timeLimit - 150);
    const timing = this.softTiming(state, started);
    const rootKey = this.keyForState(state);
    this.reportProgress("preparing", true);
    const fastChildren = this.game.legalChildren(state, false);
    this.childrenCache.set(rootKey, fastChildren);
    for (const { move, state: child } of fastChildren) {
      if (child.winner !== state.turn) continue;
      if (!this.strictChild(state, move, child)) continue;
      return {
        move,
        score: MATE_SCORE - 1,
        depth: 1,
        nodes: fastChildren.length,
        elapsed: this.now() - started,
      };
    }
    const proofMaxNodes = timing.latePosition || this.isTacticalPosition(state)
      ? this.profile.proofMaxNodes ?? 5000
      : 0;
    const proofDeadline = Math.min(
      this.deadline,
      started + Math.min(1000, this.profile.timeLimit * 0.1),
    );
    const proof = proofMaxNodes > 0
      ? new TacticalProofSearch(this.game, {
        now: this.now,
        deadline: proofDeadline,
        maxNodes: proofMaxNodes,
      }).prove(state, state.turn, this.profile.proofPlies ?? 5)
      : { status: "unknown", nodes: 0 };
    if (proof.status === "proven" && proof.line.length) {
      const move = proof.line[0];
      const child = fastChildren.find(({ move: candidate }) => moveKey(candidate) === moveKey(move))?.state;
      if (child && this.strictChild(state, move, child)) {
        return {
          move,
          score: MATE_SCORE - proof.distance,
          depth: proof.distance,
          nodes: fastChildren.length + proof.nodes,
          elapsed: this.now() - started,
        };
      }
    }
    const children = this.selectRootChildren(state);
    if (!children.length) return {
      move: null,
      score: this.baseEvaluation(state),
      depth: 0,
      nodes: 0,
      elapsed: 0,
    };
    this.childrenCache.set(rootKey, children);

    const orderedFallback = this.orderedChildren(state, 0);
    const fallback = orderedFallback.find(
      ({ move, state: child }) => child.winner !== (state.turn === "top" ? "bottom" : "top")
        && this.strictChild(state, move, child),
    ) || orderedFallback.find(
      ({ move, state: child }) => this.strictChild(state, move, child),
    );
    if (!fallback) return {
      move: null,
      score: this.baseEvaluation(state),
      depth: 0,
      nodes: 0,
      elapsed: this.now() - started,
    };
    let bestMove = fallback.move;
    let bestScore = -this.strategicEvaluation(fallback.state);
    let completedDepth = 0;
    let previousIteration = null;
    let useHardDeadline = false;
    this.nodes = fastChildren.length + proof.nodes + children.length;
    this.bestCompleted = {
      move: bestMove,
      score: bestScore,
      depth: completedDepth,
      nodes: this.nodes,
      elapsed: this.now() - started,
    };
    this.reportProgress("searching", true);
    for (let depth = 1; depth <= this.profile.maxDepth; depth += 1) {
      this.activeDepth = depth;
      this.reportProgress("searching", true);
      const iterationStarted = this.now();
      const configuredDeadline = this.deadline;
      this.deadline = useHardDeadline
        ? configuredDeadline
        : Math.min(configuredDeadline, timing.softDeadline);
      try {
        const result = this.searchRoot(state, depth);
        bestMove = result.move;
        bestScore = result.score;
        completedDepth = depth;
        this.bestCompleted = {
          move: bestMove,
          score: bestScore,
          depth: completedDepth,
          nodes: this.nodes,
          elapsed: this.now() - started,
        };
        this.ordering.set(rootKey, moveKey(bestMove));
        if (depth >= 2 && this.shouldExtendSearch(
          previousIteration,
          result,
          this.isTacticalPosition(state),
        )) {
          useHardDeadline = true;
        }
        previousIteration = result;
        this.reportProgress("searching", true);
        const now = this.now();
        const iterationElapsed = now - iterationStarted;
        if (Math.abs(bestScore) >= MATE_SCORE - 100) break;
        if (!useHardDeadline && depth >= 3 && (
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
    const variedMove = this.openingVariation(state, rootKey, bestMove, bestScore, timing);
    return {
      move: variedMove,
      score: bestScore,
      depth: completedDepth,
      nodes: this.nodes,
      elapsed: this.now() - started,
    };
  }

  /** Randomize only among exactly tied quiet opening choices. */
  openingVariation(state, rootKey, bestMove, bestScore, timing) {
    const mirrors = state.board.flat().filter(
      (cell) => [Cell.SLASH, Cell.BACKSLASH].includes(cell),
    ).length;
    if (mirrors >= 8 || timing.latePosition || this.isTacticalPosition(state)) return bestMove;
    const scores = this.rootScores.get(rootKey);
    if (!scores) return bestMove;
    const candidates = [...this.childrenCache.get(rootKey) || []]
      .filter(({ move, state: child }) => {
        const score = scores.get(moveKey(move));
        return score !== undefined
          && score === bestScore
          && child.winner !== (state.turn === "top" ? "bottom" : "top")
          && this.strictChild(state, move, child);
      });
    if (candidates.length < 2) return bestMove;
    return candidates[Math.floor(this.random() * candidates.length)].move;
  }

  /** Spend the hard budget only for unstable positions with a concrete tactical signal. */
  shouldExtendSearch(previous, current, tacticalPosition = false) {
    if (!previous || !tacticalPosition) return false;
    const scoreSwing = Math.abs(current.score - previous.score);
    const moveChanged = moveKey(current.move) !== moveKey(previous.move);
    return scoreSwing >= 180 || (moveChanged && scoreSwing >= 80);
  }

  /** Keep strong quiet roots plus every move that changes the live volley. */
  selectRootChildren(state) {
    const ordered = this.orderedChildren(state, 0);
    const selected = ordered.slice(0, this.profile.rootLimit);
    if (this.profile.includeForcingRoots === false || !this.shouldExpandRoot(state)) return selected;

    const selectedKeys = new Set(selected.map(({ move }) => moveKey(move)));
    const forcingKeys = new Set([...this.forcingMoves(state)].map(moveKey));
    for (const item of ordered) {
      const key = moveKey(item.move);
      if (!forcingKeys.has(key) || selectedKeys.has(key)) continue;
      selected.push(item);
      selectedKeys.add(key);
    }
    return selected;
  }

  /** Widen the root only when live-volley tactics dominate quiet placement. */
  shouldExpandRoot(state) {
    const mirrors = state.board.flat().filter(
      (cell) => [Cell.SLASH, Cell.BACKSLASH].includes(cell),
    ).length;
    if (mirrors >= 23) return true;
    return this.game.fireLasers(state.board).some(
      (beam) => beam.hitShield || beam.hitKing,
    );
  }

  /** Score every retained root move, then exactly validate contenders. */
  searchRoot(state, depth) {
    let alpha = -Infinity;
    const beta = Infinity;
    const key = this.keyForState(state);
    const previousScores = this.rootScores.get(key);
    const children = this.orderedChildren(state, 0);
    if (previousScores) {
      children.sort((left, right) => (
        (previousScores.get(moveKey(right.move)) ?? -Infinity)
        - (previousScores.get(moveKey(left.move)) ?? -Infinity)
      ));
    }
    const ranked = [];
    let firstChild = true;
    for (const { move, state: child } of children) {
      this.checkInterrupted();
      let score;
      if (firstChild) {
        score = -this.negamax(child, depth - 1, -beta, -alpha, 1);
        firstChild = false;
      } else {
        score = -this.negamax(child, depth - 1, -alpha - 1, -alpha, 1);
        if (score > alpha && score < beta) {
          score = -this.negamax(child, depth - 1, -beta, -alpha, 1);
        }
      }
      ranked.push({ move, state: child, score });
      if (score > alpha && this.strictChild(state, move, child, false)) alpha = score;
    }
    ranked.sort((left, right) => (
      right.score - left.score
      || this.shieldExchange(state, right.state) - this.shieldExchange(state, left.state)
    ));
    this.rootScores.set(key, new Map(
      ranked.map(({ move, score }) => [moveKey(move), score]),
    ));
    const nonSacrificing = ranked.filter(
      (candidate) => this.shieldExchange(state, candidate.state) >= 0,
    );
    const opponent = state.turn === "top" ? "bottom" : "top";
    const nonLosing = ranked.filter((candidate) => candidate.state.winner !== opponent);
    const immediateSurvivors = nonLosing.filter(
      (candidate) => !this.opponentCanWinNext(candidate.state),
    );
    const safeRanked = immediateSurvivors.length
      ? immediateSurvivors
      : nonLosing.length ? nonLosing : ranked;
    const safeNonSacrificing = nonSacrificing.filter(
      (candidate) => !this.opponentCanWinNext(candidate.state),
    );
    const candidates = this.isTacticalPosition(state) || !safeNonSacrificing.length
      ? safeRanked
      : safeNonSacrificing.filter((candidate) => candidate.state.winner !== opponent).length
        ? safeNonSacrificing.filter((candidate) => candidate.state.winner !== opponent)
        : safeRanked;
    for (const candidate of candidates) {
      this.checkInterrupted();
      if (this.strictChild(state, candidate.move, candidate.state)) {
        return { move: candidate.move, score: candidate.score };
      }
    }
    for (const candidate of ranked) {
      this.checkInterrupted();
      if (this.strictChild(state, candidate.move, candidate.state)) {
        return { move: candidate.move, score: candidate.score };
      }
    }
    throw new Error("Ultra search found no fully legal root move.");
  }

  /** Reject root moves that allow an immediate legal king hit in reply. */
  opponentCanWinNext(state) {
    const key = this.keyForState(state);
    if (this.rootSurvivalCache.has(key)) return this.rootSurvivalCache.get(key);
    if (state.winner || state.draw) {
      const losing = state.winner !== state.turn;
      this.rootSurvivalCache.set(key, losing);
      return losing;
    }
    const opponent = state.turn;
    const canWin = this.game.legalChildren(state, false).some(({ move, state: child }) => {
      this.checkInterrupted();
      return child.winner === opponent && this.game.isLegalMove(state, move);
    });
    this.rootSurvivalCache.set(key, canWin);
    return canWin;
  }

  /** Evaluate a subtree with selective alpha-beta negamax. */
  negamax(state, depth, alpha, beta, ply) {
    this.checkInterrupted();
    this.nodes += 1;
    if (state.winner) {
      const score = this.baseEvaluation(state);
      return score > 0 ? score - ply : score + ply;
    }
    if (state.draw) return 0;
    if (depth <= 0) return this.stabilizedEvaluation(state, ply);

    const originalAlpha = alpha;
    const originalBeta = beta;
    const cacheKey = `${this.keyForState(state)}|${depth}`;
    if (this.cache.has(cacheKey)) {
      const cached = this.cache.get(cacheKey);
      if (cached.bound === "exact") return cached.value;
      if (cached.bound === "lower") alpha = Math.max(alpha, cached.value);
      else beta = Math.min(beta, cached.value);
      if (alpha >= beta) return cached.value;
    }

    let children = this.orderedChildren(state, ply);
    if (!children.length) return 0;
    const branchLimit = this.profile.branchLimits[
      Math.min(Math.max(0, ply - 1), this.profile.branchLimits.length - 1)
    ];
    const kingExposed = this.game.fireLasers(state.board).some((beam) => beam.hitKing);
    children = this.strictSubset(state, children, branchLimit, kingExposed);
    if (!children.length) return 0;

    let value = -Infinity;
    let bestMove = null;
    for (const { move, state: child } of children) {
      let score;
      if (bestMove === null) {
        score = -this.negamax(child, depth - 1, -beta, -alpha, ply + 1);
      } else {
        score = -this.negamax(child, depth - 1, -alpha - 1, -alpha, ply + 1);
        if (score > alpha && score < beta) {
          score = -this.negamax(child, depth - 1, -beta, -alpha, ply + 1);
        }
      }
      if (score > value) {
        value = score;
        bestMove = move;
      }
      alpha = Math.max(alpha, value);
      if (alpha >= beta) {
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
    if (bestMove) this.ordering.set(this.keyForState(state), moveKey(bestMove));
    let bound = "exact";
    if (value <= originalAlpha) bound = "upper";
    else if (value >= originalBeta) bound = "lower";
    this.cache.set(cacheKey, { value, bound });
    return value;
  }

  /** Return legal children sorted by tactical search priority. */
  orderedChildren(state, ply = 0) {
    const key = this.keyForState(state);
    let children = this.childrenCache.get(key);
    if (!children) {
      children = this.game.legalChildren(state, false);
      this.childrenCache.set(key, children);
    }
    const preferred = this.ordering.get(key);
    const killers = this.killers.get(ply) || [];
    return children
      .map((child) => ({
        child,
        priority: this.movePriority(state, child.move, child.state, preferred, killers),
      }))
      .sort((left, right) => right.priority - left.priority)
      .map(({ child }) => child);
  }

  /** Select the highest-ranked fully legal children up to one branch limit. */
  strictSubset(state, children, limit, allowExact = false) {
    const selected = [];
    for (const item of children) {
      this.checkInterrupted();
      if (this.strictChild(state, item.move, item.state, allowExact)) selected.push(item);
      if (selected.length === limit) break;
    }
    return selected;
  }

  /** Return a fully legal child while sharing exact validator results. */
  strictChild(state, move, fastChild = null, allowExact = true) {
    const key = this.keyForState(state);
    const cache = allowExact ? this.legalityCache : this.fastLegalityCache;
    if (!cache.has(key)) cache.set(key, new Map());
    const legality = cache.get(key);
    const keyForMove = moveKey(move);
    if (legality.get(keyForMove) === false) return null;
    if (legality.get(keyForMove) === true && fastChild) return fastChild;
    if (fastChild) {
      const legal = allowExact
        ? this.game.jointPathPreserved(state.board, fastChild.board, move)
        : this.game.jointPathPreservedFast(state.board, fastChild.board, move);
      legality.set(keyForMove, legal);
      return legal ? fastChild : null;
    }
    try {
      const child = this.game.resolveMove(state, move, false).state;
      legality.set(keyForMove, true);
      return child;
    } catch {
      legality.set(keyForMove, false);
      return null;
    }
  }

  /** Rank a move for ordering without changing its position value. */
  movePriority(state, move, child, preferred, killers) {
    if (child.winner === state.turn) return 1_000_000;
    if (child.winner) return -1_000_000;
    // Ordering runs at every internal node. Keep it cheap; the full route
    // evaluation belongs at leaves and would otherwise dominate the search.
    const terminal = child.draw ? 0 : -this.orderingEvaluation(state, child) * 1000;
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

  /** Score a child cheaply for move ordering without running route searches. */
  orderingEvaluation(state, child) {
    const key = this.keyForState(child);
    if (this.orderingEvaluationCache.has(key)) return this.orderingEvaluationCache.get(key);
    let score = this.baseEvaluation(child);
    score += this.shieldExchange(state, child) * 24;
    this.orderingEvaluationCache.set(key, score);
    return score;
  }

  /** Score terminal state, king cover, and immediate next-volley exposure. */
  baseEvaluation(state) {
    const own = state.turn;
    const opponent = own === "top" ? "bottom" : "top";
    if (state.draw) return 0;
    if (state.winner === own) return MATE_SCORE;
    if (state.winner === opponent) return -MATE_SCORE;
    const shields = this.shieldMetrics(state.board);
    let hitMask = 0;
    for (const beam of this.game.fireLasers(state.board)) {
      if (beam.hitKing === "top") hitMask |= 1;
      else if (beam.hitKing === "bottom") hitMask |= 2;
    }
    const ownMask = own === "top" ? 1 : 2;
    const opponentMask = opponent === "top" ? 1 : 2;
    return (shields[own].count - shields[opponent].count) * 25
      + (hitMask & opponentMask ? 300 : 0)
      - (hitMask & ownMask ? 300 : 0);
  }

  /** Extend exposed-king horizons through all legal tactical evasions. */
  stabilizedEvaluation(state, ply) {
    if (!this.game.fireLasers(state.board).some((beam) => beam.hitKing)) {
      const forcingScore = this.forcingSetupScore(state, ply);
      return forcingScore ?? this.strategicEvaluation(state);
    }

    const opponent = state.turn === "top" ? "bottom" : "top";
    const apparentSurvivals = this.orderedChildren(state, ply)
      .filter(({ state: child }) => child.winner !== opponent);
    const children = this.strictSubset(state, apparentSurvivals, 8, true);
    let best = -Infinity;
    for (const { state: child } of children) {
      this.checkInterrupted();
      this.nodes += 1;
      if (child.winner === state.turn) return MATE_SCORE - (ply + 1);
      const candidate = child.draw ? 0 : -this.strategicEvaluation(child);
      best = Math.max(best, candidate);
    }
    return best === -Infinity ? -MATE_SCORE + (ply + 1) : best;
  }

  /** Detect a legal setup that leaves the opposing king without an escape. */
  forcingSetupScore(state, ply) {
    const key = this.keyForState(state);
    if (this.forcingCache.has(key)) {
      const distance = this.forcingCache.get(key);
      return distance === null ? null : MATE_SCORE - (ply + distance);
    }

    const own = state.turn;
    const opponent = own === "top" ? "bottom" : "top";
    for (const move of this.forcingMoves(state)) {
      this.checkInterrupted();
      const placed = state.board.map((row) => [...row]);
      placed[move.row][move.col] = move.mirror;
      const beams = this.game.fireLasers(placed);
      const hitKings = new Set(beams.map((beam) => beam.hitKing).filter(Boolean));
      if (hitKings.has(opponent)) {
        const child = this.strictChild(state, move);
        if (child?.winner === own) {
          this.forcingCache.set(key, 1);
          return MATE_SCORE - (ply + 1);
        }
        continue;
      }
      const destroyed = beams.map((beam) => beam.hitShield).filter(Boolean);
      if (!destroyed.length) continue;
      const damaged = placed.map((row) => [...row]);
      for (const [row, col] of destroyed) damaged[row][col] = Cell.EMPTY;
      if (!this.game.fireLasers(damaged).some((beam) => beam.hitKing === opponent)) continue;
      const child = this.strictChild(state, move);
      if (!child || child.winner || child.draw) continue;
      if (this.isForcedExposure(child)) {
        this.forcingCache.set(key, 2);
        return MATE_SCORE - (ply + 2);
      }
    }
    this.forcingCache.set(key, null);
    return null;
  }

  /** Return whether the side to move has no legal way to survive an exposed king. */
  isForcedExposure(state) {
    const key = this.keyForState(state);
    if (this.forcedExposureCache.has(key)) return this.forcedExposureCache.get(key);

    const defender = state.turn;
    const attacker = defender === "top" ? "bottom" : "top";
    if (!this.game.fireLasers(state.board).some((beam) => beam.hitKing === defender)) {
      this.forcedExposureCache.set(key, false);
      return false;
    }

    for (const move of this.forcingMoves(state)) {
      this.checkInterrupted();
      let child;
      try {
        child = this.game.resolveMove(state, move, false, false).state;
      } catch {
        continue;
      }
      if (child.winner === attacker) continue;
      if (this.strictChild(state, move, child)) {
        this.forcedExposureCache.set(key, false);
        return false;
      }
    }
    this.forcedExposureCache.set(key, true);
    return true;
  }

  /** Yield only placements capable of changing the lasers' current volley. */
  *forcingMoves(state) {
    const liveSquares = new Uint8Array(BOARD_SIZE * BOARD_SIZE);
    for (const beam of this.game.fireLasers(state.board)) {
      for (const [row, col] of beam.path) liveSquares[row * BOARD_SIZE + col] = 1;
    }
    for (const move of this.game.pseudoMoves(state)) {
      if (liveSquares[move.row * BOARD_SIZE + move.col]) yield move;
    }
  }

  /** Score shield shape, live beam pressure, and route resilience. */
  strategicEvaluation(state) {
    const key = this.keyForState(state);
    if (this.evaluationCache.has(key)) return this.evaluationCache.get(key);

    const components = this.strategicEvaluationComponents(state);
    const score = Object.values(components).reduce((total, value) => total + value, 0);
    this.evaluationCache.set(key, score);
    return score;
  }

  /** Return named evaluation terms so each heuristic can be tested independently. */
  strategicEvaluationComponents(state) {
    const own = state.turn;
    const opponent = own === "top" ? "bottom" : "top";
    const terminal = state.draw
      ? 0
      : state.winner === own
        ? MATE_SCORE
        : state.winner === opponent ? -MATE_SCORE : 0;
    if (state.winner || state.draw) {
      return {
        terminal,
        shieldCount: 0,
        shieldShape: 0,
        reachability: 0,
        routeControl: 0,
        exposure: 0,
      };
    }
    const shieldMetrics = this.shieldMetrics(state.board);
    const shieldCount = (
      shieldMetrics[own].count - shieldMetrics[opponent].count
    ) * 25;
    const shieldShape = shieldMetrics[own].shape - shieldMetrics[opponent].shape;

    const reachable = this.game.reachableKingMasksByLaser(state.board);
    const attackMask = opponent === "top" ? 1 : 2;
    const exposedMask = own === "top" ? 1 : 2;
    let attackRoutes = 0;
    let exposedRoutes = 0;
    for (const mask of reachable) {
      if (mask & attackMask) attackRoutes += 1;
      if (mask & exposedMask) exposedRoutes += 1;
    }
    const reachability = (attackRoutes - exposedRoutes) * 18;

    const routeCosts = this.game.routeCostsByLaser(state.board);
    const routeControl = routePressureScore(routeCosts, own, opponent);

    let hitMask = 0;
    for (const beam of this.game.fireLasers(state.board)) {
      if (beam.hitKing === "top") hitMask |= 1;
      else if (beam.hitKing === "bottom") hitMask |= 2;
    }
    const exposure = (hitMask & attackMask ? 540 : 0)
      - (hitMask & exposedMask ? 540 : 0);
    return {
      terminal,
      shieldCount,
      shieldShape,
      reachability,
      routeControl,
      exposure,
    };
  }

  /** Prefer equal-scoring moves that damage opposing king cover over friendly cover. */
  shieldExchange(state, child) {
    const own = state.turn;
    const opponent = own === "top" ? "bottom" : "top";
    const before = this.shieldMetrics(state.board);
    const after = this.shieldMetrics(child.board);
    const ownLost = before[own].count - after[own].count;
    const opponentLost = before[opponent].count - after[opponent].count;
    return opponentLost - ownLost;
  }

  /** Cache shield count and distance-weighted shape for both fixed kings. */
  shieldMetrics(board) {
    let metrics = this.shieldMetricsCache.get(board);
    if (metrics) return metrics;
    metrics = {
      top: { count: 0, shape: 0 },
      bottom: { count: 0, shape: 0 },
    };
    for (let row = 0; row < BOARD_SIZE; row += 1) {
      for (let col = 0; col < BOARD_SIZE; col += 1) {
        if (board[row][col] !== Cell.SHIELD) continue;
        const topDistance = Math.max(row, Math.abs(col - 4));
        const bottomDistance = Math.max(BOARD_SIZE - 1 - row, Math.abs(col - 4));
        if (topDistance <= 2) metrics.top.count += 1;
        if (bottomDistance <= 2) metrics.bottom.count += 1;
        if (topDistance === 1) metrics.top.shape += 18;
        else if (topDistance === 2) metrics.top.shape += 6;
        if (bottomDistance === 1) metrics.bottom.shape += 18;
        else if (bottomDistance === 2) metrics.bottom.shape += 6;
      }
    }
    this.shieldMetricsCache.set(board, metrics);
    return metrics;
  }

  /** Return a stable serialized key for an immutable search state. */
  keyForState(state) {
    let key = this.stateKeys.get(state);
    if (!key) {
      key = `${state.turn}|${state.winner || ""}|${state.draw ? 1 : 0}|${this.game.boardKey(state.board)}`;
      this.stateKeys.set(state, key);
    }
    return key;
  }

  /** Abort once the configured search deadline is reached. */
  checkInterrupted() {
    const now = this.now();
    if (now >= this.deadline) throw new SearchInterrupted();
    if (now - this.lastProgressAt >= 250) this.reportProgress("searching", false, now);
  }

  /** Publish throttled search metrics without coupling the engine to the interface. */
  reportProgress(phase, force = false, now = this.now()) {
    if (!force && now - this.lastProgressAt < 250) return;
    this.lastProgressAt = now;
    this.onProgress({
      phase,
      depth: this.activeDepth,
      nodes: this.nodes,
      best: this.bestCompleted,
    });
  }

  /** Set a phase-aware think target below the absolute search deadline. */
  softTiming(state, started) {
    const mirrors = state.board.flat().filter((cell) => [Cell.SLASH, Cell.BACKSLASH].includes(cell)).length;
    const latePosition = mirrors >= 23;
    const tacticalEmergency = this.isTacticalPosition(state);
    const softLimit = latePosition ? 10000 : tacticalEmergency ? 8000 : mirrors >= 12 ? 6000 : 4000;
    return {
      latePosition,
      softDeadline: Math.min(this.deadline, started + softLimit),
    };
  }

  /** Identify live laser pressure that justifies using Ultra's full think budget. */
  isTacticalPosition(state) {
    const own = state.turn;
    const opponent = own === "top" ? "bottom" : "top";
    const routePressure = routePressureScore(this.game.routeCostsByLaser(state.board), own, opponent);
    const beams = this.game.fireLasers(state.board);
    return routePressure <= -180 || beams.some((beam) => beam.hitShield || beam.hitKing);
  }
}

/** Dispatch a computer move search to the requested difficulty profile. */
export function chooseComputerMove(game, state, difficulty = "medium", options = {}) {
  const random = options.random || Math.random;
  const now = options.now || (() => performance.now());
  return difficulty === "ultra"
    ? new UltraSearch(game, now, ULTRA_PROFILE, options.onProgress, random).choose(state)
    : standardMove(game, state, difficulty, random);
}

/** Create a match-scoped player with isolated turn-local Ultra heuristics. */
export function createComputerPlayer(game) {
  let ultraSearch = null;
  return (state, difficulty = "medium", options = {}) => {
    if (difficulty !== "ultra") return chooseComputerMove(game, state, difficulty, options);
    const now = options.now || (() => performance.now());
    if (!ultraSearch) {
      ultraSearch = new UltraSearch(game, now, ULTRA_PROFILE, options.onProgress, options.random || Math.random);
    } else {
      ultraSearch.now = now;
      ultraSearch.onProgress = options.onProgress || (() => {});
      ultraSearch.random = options.random || Math.random;
    }
    return ultraSearch.choose(state);
  };
}
