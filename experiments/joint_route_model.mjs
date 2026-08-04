import { BOARD_SIZE, Cell } from "../web/engine.js";

const DIRECTION_INDEX = Object.freeze({ N: 0, E: 1, S: 2, W: 3 });
const DIRECTION_STEPS = Object.freeze([[-1, 0], [0, 1], [1, 0], [0, -1]]);
const SLASH_TURN = Object.freeze([1, 0, 3, 2]);
const BACKSLASH_TURN = Object.freeze([3, 2, 1, 0]);
const KING_CELL = Object.freeze({ top: Cell.TOP_KING, bottom: Cell.BOTTOM_KING });
const DEFAULT_OPTIONS = Object.freeze({
  maxActions: 7,
  maxExpanded: 18_000,
  plansPerTarget: 48,
  plansPerNode: 32,
  redundancySlack: 1,
});

export const JOINT_ROUTE_PRESETS = Object.freeze({
  search: Object.freeze({
    maxActions: 6,
    maxExpanded: 6_000,
    plansPerTarget: 8,
    plansPerNode: 8,
    redundancySlack: 1,
  }),
  analysis: DEFAULT_OPTIONS,
});

/** Count set bits in one route-requirement mask. */
function bitCount(mask) {
  let count = 0;
  while (mask) {
    mask &= mask - 1n;
    count += 1;
  }
  return count;
}

/** Return the number of future placements and shield-clearing volleys in a plan. */
function actionCount(plan) {
  return bitCount(plan.slash | plan.backslash) + bitCount(plan.clear);
}

/** Push a lowest-cost-first route state onto a binary heap. */
function heapPush(heap, item) {
  heap.push(item);
  let index = heap.length - 1;
  while (index > 0) {
    const parent = Math.floor((index - 1) / 2);
    if (heap[parent].priority <= item.priority) break;
    heap[index] = heap[parent];
    index = parent;
  }
  heap[index] = item;
}

/** Remove the lowest-cost route state from a binary heap. */
function heapPop(heap) {
  const first = heap[0];
  const tail = heap.pop();
  if (!heap.length) return first;
  let index = 0;
  while (true) {
    const left = index * 2 + 1;
    const right = left + 1;
    if (left >= heap.length) break;
    const child = right < heap.length && heap[right].priority < heap[left].priority
      ? right
      : left;
    if (heap[child].priority >= tail.priority) break;
    heap[index] = heap[child];
    index = child;
  }
  heap[index] = tail;
  return first;
}

/** Encode the geometry that a route needs from all currently mutable squares. */
function requirementKey(plan) {
  return `${plan.empty.toString(36)}:${plan.slash.toString(36)}:${plan.backslash.toString(36)}:${plan.clear.toString(36)}`;
}

/** Return whether two future laser routes can coexist on one board. */
export function compatiblePlans(left, right) {
  const leftMirrors = left.slash | left.backslash;
  const rightMirrors = right.slash | right.backslash;
  return !(left.empty & rightMirrors)
    && !(right.empty & leftMirrors)
    && !(left.slash & right.backslash)
    && !(left.backslash & right.slash);
}

/** Count shared actions once when two compatible routes use the same geometry. */
function jointActionCount(left, right) {
  return bitCount(left.slash | right.slash | left.backslash | right.backslash)
    + bitCount(left.clear | right.clear);
}

/** Add one candidate transition if its requirements remain internally consistent. */
function addCandidate(heap, state, row, col, direction, masks, options) {
  const cost = bitCount(masks.slash | masks.backslash) + bitCount(masks.clear);
  if (cost > options.maxActions) return;
  heapPush(heap, {
    row,
    col,
    direction,
    empty: masks.empty,
    slash: masks.slash,
    backslash: masks.backslash,
    clear: masks.clear,
    steps: state.steps + 1,
    firstAction: state.firstAction || masks.firstAction || null,
    priority: cost * 256 + Math.min(state.steps + 1, 255),
  });
}

/** Enumerate a bounded, cost-ordered set of distinct future routes to one king. */
export function enumerateRoutePlans(board, source, target, overrides = {}) {
  const options = { ...DEFAULT_OPTIONS, ...overrides };
  const heap = [];
  const plans = [];
  const planKeys = new Set();
  const nodeKeys = Array.from({ length: BOARD_SIZE * BOARD_SIZE * 4 }, () => new Set());
  let expanded = 0;
  heapPush(heap, {
    row: source[0],
    col: source[1],
    direction: DIRECTION_INDEX[source[2]],
    empty: 0n,
    slash: 0n,
    backslash: 0n,
    clear: 0n,
    steps: 0,
    firstAction: null,
    priority: 0,
  });

  while (heap.length && plans.length < options.plansPerTarget && expanded < options.maxExpanded) {
    const state = heapPop(heap);
    const [dr, dc] = DIRECTION_STEPS[state.direction];
    const row = state.row + dr;
    const col = state.col + dc;
    if (row < 0 || row >= BOARD_SIZE || col < 0 || col >= BOARD_SIZE) continue;
    expanded += 1;

    const cell = board[row][col];
    if (cell === Cell.TOP_KING || cell === Cell.BOTTOM_KING) {
      if (cell !== KING_CELL[target]) continue;
      const key = requirementKey(state);
      if (planKeys.has(key)) continue;
      planKeys.add(key);
      plans.push({
        empty: state.empty,
        slash: state.slash,
        backslash: state.backslash,
        clear: state.clear,
        steps: state.steps + 1,
        firstAction: state.firstAction,
        actions: actionCount(state),
      });
      continue;
    }

    const nodeIndex = ((row * BOARD_SIZE + col) * 4) + state.direction;
    const key = requirementKey(state);
    const seen = nodeKeys[nodeIndex];
    if (seen.has(key) || seen.size >= options.plansPerNode) continue;
    seen.add(key);

    if (cell === Cell.SLASH) {
      addCandidate(heap, state, row, col, SLASH_TURN[state.direction], state, options);
      continue;
    }
    if (cell === Cell.BACKSLASH) {
      addCandidate(heap, state, row, col, BACKSLASH_TURN[state.direction], state, options);
      continue;
    }
    if (cell !== Cell.EMPTY && cell !== Cell.SHIELD) continue;

    const bit = 1n << BigInt(row * BOARD_SIZE + col);
    const cleared = cell === Cell.SHIELD ? state.clear | bit : state.clear;
    const clearAction = cell === Cell.SHIELD && !(state.clear & bit) ? `clear:${row},${col}` : null;
    if (state.slash & bit) {
      addCandidate(heap, state, row, col, SLASH_TURN[state.direction], {
        ...state,
        clear: cleared,
        firstAction: clearAction,
      }, options);
    } else if (state.backslash & bit) {
      addCandidate(heap, state, row, col, BACKSLASH_TURN[state.direction], {
        ...state,
        clear: cleared,
        firstAction: clearAction,
      }, options);
    } else if (state.empty & bit) {
      addCandidate(heap, state, row, col, state.direction, {
        ...state,
        clear: cleared,
        firstAction: clearAction,
      }, options);
    } else {
      addCandidate(heap, state, row, col, state.direction, {
        ...state,
        empty: state.empty | bit,
        clear: cleared,
        firstAction: clearAction,
      }, options);
      if (!options.forbiddenTurns?.[row * BOARD_SIZE + col]) {
        addCandidate(heap, state, row, col, SLASH_TURN[state.direction], {
          ...state,
          slash: state.slash | bit,
          clear: cleared,
          firstAction: clearAction || `/:${row},${col}`,
        }, options);
        addCandidate(heap, state, row, col, BACKSLASH_TURN[state.direction], {
          ...state,
          backslash: state.backslash | bit,
          clear: cleared,
          firstAction: clearAction || `\\:${row},${col}`,
        }, options);
      }
    }
  }

  return { plans, expanded, truncated: Boolean(heap.length) };
}

/** Build compatible route pairs for one left/right target assignment. */
function combineAssignment(leftPlans, rightPlans, targets) {
  const pairs = [];
  for (const left of leftPlans) {
    for (const right of rightPlans) {
      if (!compatiblePlans(left, right)) continue;
      pairs.push({
        left,
        right,
        targets,
        jointActions: jointActionCount(left, right),
      });
    }
  }
  pairs.sort((a, b) => a.jointActions - b.jointActions
    || (a.left.actions + a.right.actions) - (b.left.actions + b.right.actions));
  return pairs;
}

/** Summarize attack, danger, assignment, and redundancy from compatible routes. */
function summarizePairs(assignments, perspective, options) {
  const opponent = perspective === "top" ? "bottom" : "top";
  const allPairs = assignments.flatMap((assignment) => assignment.pairs);
  if (!allPairs.length) {
    return {
      attackTempo: options.maxActions + 1,
      dangerTempo: options.maxActions + 1,
      attackRedundancy: 0,
      dangerRedundancy: 0,
      assignmentFlexibility: 0,
      assignmentCosts: [Infinity, Infinity],
      minimumJointActions: Infinity,
      race: 0,
    };
  }

  const annotated = allPairs.map((pair) => {
    const leftAttacks = pair.targets[0] === opponent;
    const attack = leftAttacks ? pair.left : pair.right;
    const danger = leftAttacks ? pair.right : pair.left;
    return { ...pair, attack, danger };
  });
  const attackTempo = Math.min(...annotated.map((pair) => pair.attack.actions));
  const dangerTempo = Math.min(...annotated.map((pair) => pair.danger.actions));
  const minimumJointActions = Math.min(...annotated.map((pair) => pair.jointActions));
  const useful = annotated.filter((pair) => (
    pair.jointActions <= minimumJointActions + 2
    && pair.attack.actions <= attackTempo + options.redundancySlack
    && pair.danger.actions <= dangerTempo + options.redundancySlack
  ));
  const attackRoutes = new Set(useful.map((pair) => requirementKey(pair.attack)));
  const dangerRoutes = new Set(useful.map((pair) => requirementKey(pair.danger)));
  const assignmentCosts = assignments.map(({ pairs }) => (
    pairs.length ? pairs[0].jointActions : Infinity
  ));
  const assignmentFlexibility = assignmentCosts.filter(Number.isFinite).length;

  return {
    attackTempo,
    dangerTempo,
    attackRedundancy: attackRoutes.size,
    dangerRedundancy: dangerRoutes.size,
    assignmentFlexibility,
    assignmentCosts,
    minimumJointActions,
    race: dangerTempo - attackTempo,
  };
}

/** Evaluate both lasers as compatible route pairs instead of independent paths. */
export function jointRouteProfile(game, board, perspective, overrides = {}) {
  const options = {
    ...DEFAULT_OPTIONS,
    ...overrides,
    forbiddenTurns: game.mirrorForbiddenMask(board),
  };
  const started = performance.now();
  const routeSets = game.sources.map((source) => ({
    top: enumerateRoutePlans(board, source, "top", options),
    bottom: enumerateRoutePlans(board, source, "bottom", options),
  }));
  const assignments = [
    { targets: ["top", "bottom"] },
    { targets: ["bottom", "top"] },
  ].map(({ targets }) => ({
    targets,
    pairs: combineAssignment(
      routeSets[0][targets[0]].plans,
      routeSets[1][targets[1]].plans,
      targets,
    ),
  }));
  const profile = summarizePairs(assignments, perspective, options);
  return {
    ...profile,
    expanded: routeSets.reduce(
      (total, routes) => total + routes.top.expanded + routes.bottom.expanded,
      0,
    ),
    routeCounts: routeSets.map((routes) => [routes.top.plans.length, routes.bottom.plans.length]),
    individualCosts: routeSets.map((routes) => ({
      top: routes.top.plans[0]?.actions ?? Infinity,
      bottom: routes.bottom.plans[0]?.actions ?? Infinity,
    })),
    compatiblePairs: assignments.map((assignment) => assignment.pairs.length),
    truncated: routeSets.some((routes) => routes.top.truncated || routes.bottom.truncated),
    milliseconds: performance.now() - started,
  };
}

/** Convert a joint-route profile into an intentionally transparent test score. */
export function jointRouteScore(profile) {
  const tempo = profile.race * 180;
  const redundancy = Math.max(-12, Math.min(
    12,
    profile.attackRedundancy - profile.dangerRedundancy,
  )) * 8;
  const flexibility = (profile.assignmentFlexibility - 1) * 20;
  return tempo + redundancy + flexibility;
}
