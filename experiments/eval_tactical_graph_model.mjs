import { BOARD_SIZE, Cell } from "../web/engine.js";
import { ThreatSpaceSearch } from "../web/tactics.js";

const PLAYER_MASK = Object.freeze({ top: 1, bottom: 2 });
const OPPONENT = Object.freeze({ top: "bottom", bottom: "top" });
const TOP_SHIELDS = new Set(["0,3", "0,5", "1,3", "1,4", "1,5", "2,4"]);
const BOTTOM_SHIELDS = new Set(["8,3", "8,5", "7,3", "7,4", "7,5", "6,4"]);
const ROUTE_CAP = 8;

export const TACTICAL_GRAPH_FAMILIES = Object.freeze([
  "terminal",
  "certificate",
  "tempo",
  "defensiveResources",
  "assignment",
  "cascade",
  "routeGeometry",
  "shields",
]);

export const TACTICAL_GRAPH_WEIGHTS = Object.freeze({
  mate: 10_000,
  certificate: 3_200,
  certificatePly: 180,
  immediateWin: 2_400,
  loadedThreat: 320,
  forcingThreat: 520,
  defensiveMove: 46,
  defensiveSquare: 34,
  assignment: 105,
  singletonAssignment: 90,
  cascadeKing: 120,
  cascadeShield: 28,
  routeGeometry: 18,
  shield: 38,
});

/** Return a board clone whose side to move is selected without changing geometry. */
function stateForPlayer(state, player) {
  return {
    board: state.board,
    turn: player,
    winner: null,
    draw: false,
  };
}

/** Return a stable move label for reports and deterministic sorting. */
export function tacticalMoveLabel(move) {
  return `${move.mirror} R${move.row + 1}C${move.col + 1}`;
}

/** Count shields belonging to each king's fixed enclosure. */
function shieldCounts(board) {
  const counts = { top: 0, bottom: 0 };
  for (let row = 0; row < BOARD_SIZE; row += 1) {
    for (let col = 0; col < BOARD_SIZE; col += 1) {
      if (board[row][col] !== Cell.SHIELD) continue;
      const square = `${row},${col}`;
      if (TOP_SHIELDS.has(square)) counts.top += 1;
      if (BOTTOM_SHIELDS.has(square)) counts.bottom += 1;
    }
  }
  return counts;
}

/** Identify the king enclosure that owns one shield coordinate. */
function shieldOwner(square) {
  if (!square) return null;
  const key = `${square[0]},${square[1]}`;
  if (TOP_SHIELDS.has(key)) return "top";
  if (BOTTOM_SHIELDS.has(key)) return "bottom";
  return null;
}

/** Mark every empty board square where a mirror can alter the current volley. */
function liveVolleyMask(game, board) {
  const mask = new Uint8Array(BOARD_SIZE * BOARD_SIZE);
  for (const beam of game.fireLasers(board)) {
    for (const [row, col] of beam.path) mask[row * BOARD_SIZE + col] = 1;
  }
  return mask;
}

/** Resolve every exact legal move capable of changing the current laser paths. */
function liveVolleyChildren(game, state) {
  const mask = liveVolleyMask(game, state.board);
  const children = [];
  for (const move of game.pseudoMoves(state)) {
    if (!mask[move.row * BOARD_SIZE + move.col]) continue;
    try {
      const outcome = game.resolveMove(state, move, false, true);
      children.push({ move, ...outcome });
    } catch {
      // A live-path placement must still satisfy all exact route invariants.
    }
  }
  return children;
}

/** Count exact replies that prevent a loaded beam from deciding the game. */
function defensiveResources(game, threatenedState, attacker, defender) {
  const beams = game.fireLasers(threatenedState.board);
  const defenderExposed = beams.some((beam) => beam.hitKing === defender);
  if (!defenderExposed) return { moves: Infinity, squares: Infinity, orientations: Infinity };
  const attackerExposed = beams.some((beam) => beam.hitKing === attacker);
  const candidates = attackerExposed
    ? game.legalChildren(threatenedState, true).map(({ move, state }) => ({ move, state }))
    : liveVolleyChildren(game, threatenedState).map(({ move, state }) => ({ move, state }));
  const survivors = candidates.filter(({ state }) => state.winner !== attacker);
  const squares = new Set(survivors.map(({ move }) => `${move.row},${move.col}`));
  const orientations = new Set(survivors.map(({ move }) => move.mirror));
  return {
    moves: survivors.length,
    squares: squares.size,
    orientations: orientations.size,
  };
}

/** Build per-laser shield dependency chains by repeatedly clearing volley contacts. */
export function buildShieldDependencyGraph(game, board) {
  let working = board.map((row) => [...row]);
  const chains = [[], []];
  const removed = new Set();
  for (let layer = 0; layer <= 12; layer += 1) {
    const beams = game.fireLasers(working);
    const newlyDestroyed = [];
    for (let laser = 0; laser < beams.length; laser += 1) {
      const beam = beams[laser];
      if (beam.hitShield) {
        const square = `${beam.hitShield[0]},${beam.hitShield[1]}`;
        chains[laser].push({
          layer,
          type: "shield",
          square: beam.hitShield,
          owner: shieldOwner(beam.hitShield),
        });
        if (!removed.has(square)) {
          removed.add(square);
          newlyDestroyed.push(beam.hitShield);
        }
      } else if (beam.hitKing) {
        chains[laser].push({ layer, type: "king", player: beam.hitKing });
      } else {
        chains[laser].push({ layer, type: beam.looped ? "loop" : "exit" });
      }
    }
    if (!newlyDestroyed.length) break;
    const nextBoard = working.map((row) => [...row]);
    for (const [row, col] of newlyDestroyed) nextBoard[row][col] = Cell.EMPTY;
    working = nextBoard;
  }
  return { chains, removedShields: removed.size };
}

/** Summarize one side's shortest routes without treating geometry as a forced attack. */
function routeProfile(game, board, attacker) {
  const defender = OPPONENT[attacker];
  const defenderMask = PLAYER_MASK[defender];
  const attackerMask = PLAYER_MASK[attacker];
  const masks = game.reachableKingMasksByLaser(board);
  const costs = game.routeCostsByLaser(board);
  const attackCosts = costs.map((route) => Math.min(route[defender] ?? ROUTE_CAP, ROUTE_CAP));
  const dangerCosts = costs.map((route) => Math.min(route[attacker] ?? ROUTE_CAP, ROUTE_CAP));
  return {
    masks,
    attackCosts,
    dangerCosts,
    nearestAttack: Math.min(...attackCosts),
    reserveAttack: Math.max(...attackCosts),
    exclusiveAttackLasers: masks.filter((mask) => mask === defenderMask).length,
    exclusiveDangerLasers: masks.filter((mask) => mask === attackerMask).length,
    targetReachableLasers: masks.filter((mask) => mask & defenderMask).length,
    singletonSplit: masks.every((mask) => mask === 1 || mask === 2)
      && new Set(masks).size === 2,
  };
}

/** Return cascade depth and shield dependencies for one attacking side. */
function cascadeProfile(graph, attacker) {
  const defender = OPPONENT[attacker];
  const kingChains = graph.chains.filter(
    (chain) => chain.some((node) => node.type === "king" && node.player === defender),
  );
  const layers = kingChains.map((chain) => (
    chain.find((node) => node.type === "king" && node.player === defender)?.layer ?? Infinity
  ));
  const defendingShields = new Set();
  const friendlyCollateral = new Set();
  for (const chain of kingChains) {
    for (const node of chain) {
      if (node.type !== "shield") continue;
      const key = `${node.square[0]},${node.square[1]}`;
      if (node.owner === defender) defendingShields.add(key);
      if (node.owner === attacker) friendlyCollateral.add(key);
    }
  }
  return {
    kingChains: kingChains.length,
    minimumLayers: layers.length ? Math.min(...layers) : Infinity,
    defendingShields: defendingShields.size,
    friendlyCollateral: friendlyCollateral.size,
  };
}

/** Measure legal threats, forced replies, route assignment, and optional proof certificates. */
export function analyzeTacticalPotential(game, state, attacker, options = {}) {
  const defender = OPPONENT[attacker];
  const synthetic = stateForPlayer(state, attacker);
  const routes = routeProfile(game, state.board, attacker);
  const graph = options.dependencyGraph || buildShieldDependencyGraph(game, state.board);
  const cascade = cascadeProfile(graph, attacker);
  const currentBeams = game.fireLasers(state.board);
  const alreadyLoaded = currentBeams.some((beam) => beam.hitKing === defender);
  const candidates = liveVolleyChildren(game, synthetic);
  let immediateWins = 0;
  const threats = [];
  for (const candidate of candidates) {
    if (candidate.state.winner === attacker) {
      immediateWins += 1;
      continue;
    }
    if (candidate.state.winner || candidate.state.draw) continue;
    if (!game.fireLasers(candidate.state.board).some((beam) => beam.hitKing === defender)) continue;
    const resources = defensiveResources(game, candidate.state, attacker, defender);
    threats.push({
      move: candidate.move,
      destroyed: candidate.destroyed.length,
      resources,
    });
  }
  threats.sort((left, right) => (
    left.resources.moves - right.resources.moves
    || left.resources.squares - right.resources.squares
    || right.destroyed - left.destroyed
    || tacticalMoveLabel(left.move).localeCompare(tacticalMoveLabel(right.move))
  ));

  let certificate = { status: "not-run", nodes: 0 };
  if (options.proofPlies > 0 && (immediateWins || threats.length || alreadyLoaded)) {
    certificate = new ThreatSpaceSearch(game, {
      maxNodes: options.proofMaxNodes ?? 4_000,
      deadline: options.proofDeadline ?? Infinity,
    }).prove(synthetic, attacker, options.proofPlies);
  }
  const bestResources = threats[0]?.resources || {
    moves: Infinity,
    squares: Infinity,
    orientations: Infinity,
  };
  return {
    attacker,
    defender,
    routes,
    cascade,
    alreadyLoaded,
    immediateWins,
    loadedThreats: threats.length,
    forcingThreats: threats.filter(({ resources }) => resources.moves <= 2).length,
    bestDefensiveMoves: bestResources.moves,
    bestDefensiveSquares: bestResources.squares,
    bestDefensiveOrientations: bestResources.orientations,
    certificate,
    threats: options.includeThreats ? threats : undefined,
  };
}

/** Convert one attack profile into independently ablatable score components. */
function attackComponents(profile) {
  const proofDistance = profile.certificate.status === "proven"
    ? profile.certificate.distance
    : null;
  const certificate = proofDistance === null
    ? 0
    : TACTICAL_GRAPH_WEIGHTS.certificate
      - Math.max(0, proofDistance - 1) * TACTICAL_GRAPH_WEIGHTS.certificatePly;
  const tempo = profile.immediateWins
    ? TACTICAL_GRAPH_WEIGHTS.immediateWin + Math.min(4, profile.immediateWins - 1) * 40
    : profile.loadedThreats * TACTICAL_GRAPH_WEIGHTS.loadedThreat
      + profile.forcingThreats * TACTICAL_GRAPH_WEIGHTS.forcingThreat;
  const defensiveMoves = Number.isFinite(profile.bestDefensiveMoves)
    ? Math.max(0, 8 - profile.bestDefensiveMoves)
    : 0;
  const defensiveSquares = Number.isFinite(profile.bestDefensiveSquares)
    ? Math.max(0, 6 - profile.bestDefensiveSquares)
    : 0;
  const defensiveResources = defensiveMoves * TACTICAL_GRAPH_WEIGHTS.defensiveMove
    + defensiveSquares * TACTICAL_GRAPH_WEIGHTS.defensiveSquare;
  const enforceability = certificate > 0 || profile.immediateWins
    ? 1
    : profile.loadedThreats
      ? Math.min(0.85, 0.2 + defensiveMoves / 10)
      : 0.06;
  const routeGeometry = (
    Math.max(0, ROUTE_CAP - profile.routes.nearestAttack) * 1.5
    + Math.max(0, ROUTE_CAP - profile.routes.reserveAttack) * 0.5
  ) * TACTICAL_GRAPH_WEIGHTS.routeGeometry * enforceability;
  const assignment = (
    profile.routes.exclusiveAttackLasers * TACTICAL_GRAPH_WEIGHTS.assignment
    + Number(profile.routes.singletonSplit) * TACTICAL_GRAPH_WEIGHTS.singletonAssignment
  ) * Math.max(0.18, enforceability);
  const cascade = profile.cascade.kingChains
    ? (
      profile.cascade.kingChains * TACTICAL_GRAPH_WEIGHTS.cascadeKing
      + profile.cascade.defendingShields * TACTICAL_GRAPH_WEIGHTS.cascadeShield
      - profile.cascade.friendlyCollateral * TACTICAL_GRAPH_WEIGHTS.cascadeShield
    ) * Math.max(0.12, enforceability)
    : 0;
  return { certificate, tempo, defensiveResources, assignment, cascade, routeGeometry };
}

/** Evaluate one state from a fixed player's perspective with named graph components. */
export function tacticalGraphEvaluation(game, state, perspective = state.turn, options = {}) {
  const opponent = OPPONENT[perspective];
  if (state.draw) {
    return { score: 0, components: Object.fromEntries(TACTICAL_GRAPH_FAMILIES.map((name) => [name, 0])) };
  }
  if (state.winner) {
    const terminal = state.winner === perspective
      ? TACTICAL_GRAPH_WEIGHTS.mate
      : -TACTICAL_GRAPH_WEIGHTS.mate;
    return {
      score: terminal,
      components: {
        terminal,
        certificate: 0,
        tempo: 0,
        defensiveResources: 0,
        assignment: 0,
        cascade: 0,
        routeGeometry: 0,
        shields: 0,
      },
    };
  }
  const dependencyGraph = buildShieldDependencyGraph(game, state.board);
  const attack = analyzeTacticalPotential(game, state, perspective, {
    ...options,
    dependencyGraph,
  });
  const danger = analyzeTacticalPotential(game, state, opponent, {
    ...options,
    dependencyGraph,
  });
  const attackScores = attackComponents(attack);
  const dangerScores = attackComponents(danger);
  const shields = shieldCounts(state.board);
  const components = {
    terminal: 0,
    certificate: attackScores.certificate - dangerScores.certificate,
    tempo: attackScores.tempo - dangerScores.tempo,
    defensiveResources: attackScores.defensiveResources - dangerScores.defensiveResources,
    assignment: attackScores.assignment - dangerScores.assignment,
    cascade: attackScores.cascade - dangerScores.cascade,
    routeGeometry: attackScores.routeGeometry - dangerScores.routeGeometry,
    shields: (shields[perspective] - shields[opponent]) * TACTICAL_GRAPH_WEIGHTS.shield,
  };
  const excluded = new Set(options.excludeFamilies || []);
  const score = Object.entries(components).reduce(
    (total, [name, value]) => total + (excluded.has(name) ? 0 : value),
    0,
  );
  return { score, components, attack, danger };
}

/** Return a route-only control score used as the experiment's weak baseline. */
export function routeOnlyEvaluation(game, state, perspective) {
  if (state.winner) return state.winner === perspective ? 10_000 : -10_000;
  if (state.draw) return 0;
  const attack = routeProfile(game, state.board, perspective);
  const danger = routeProfile(game, state.board, OPPONENT[perspective]);
  const proximity = (profile) => (
    Math.max(0, ROUTE_CAP - profile.nearestAttack) * 1.5
    + Math.max(0, ROUTE_CAP - profile.reserveAttack) * 0.5
  );
  return (proximity(attack) - proximity(danger)) * TACTICAL_GRAPH_WEIGHTS.routeGeometry;
}

/** Detect whether the board has one permanently singleton-assigned laser per king. */
export function hasSplitSingletonAssignment(game, state) {
  const masks = game.reachableKingMasksByLaser(state.board);
  return masks.every((mask) => mask === 1 || mask === 2) && new Set(masks).size === 2;
}
