import MiniSat from "./minisat.js?v=0.13.5";

const BOARD_SIZE = 9;
const EMPTY = ".";
const SLASH_MIRROR = "/";
const BACKSLASH_MIRROR = "\\";
const TOP_KING = "k";
const BOTTOM_KING = "K";
const SHIELD = "O";
const DIRECTIONS = {
  N: [-1, 0],
  E: [0, 1],
  S: [1, 0],
  W: [0, -1],
};
const SLASH_TURN = { N: "E", E: "N", S: "W", W: "S" };
const BACKSLASH_TURN = { N: "W", W: "N", S: "E", E: "S" };
const HORIZONTAL_DIRECTION = { N: "N", E: "W", S: "S", W: "E" };
const VERTICAL_DIRECTION = { N: "S", E: "E", S: "N", W: "W" };

function squareKey(row, col) {
  return `${row},${col}`;
}

function stateKey(row, col, direction) {
  return `${row},${col},${direction}`;
}

/** Reflect one board coordinate across either rule-preserving axis. */
function transformedPosition(row, col, horizontal, vertical) {
  return [
    vertical ? BOARD_SIZE - 1 - row : row,
    horizontal ? BOARD_SIZE - 1 - col : col,
  ];
}

/** Reflect the board while preserving top/bottom king identities. */
function transformedBoard(board, horizontal, vertical) {
  const transformed = Array.from(
    { length: BOARD_SIZE },
    () => Array(BOARD_SIZE).fill(EMPTY),
  );
  const swapsMirror = horizontal !== vertical;
  for (let row = 0; row < BOARD_SIZE; row += 1) {
    for (let col = 0; col < BOARD_SIZE; col += 1) {
      const [nextRow, nextCol] = transformedPosition(row, col, horizontal, vertical);
      let cell = board[row][col];
      if (swapsMirror && cell === SLASH_MIRROR) cell = BACKSLASH_MIRROR;
      else if (swapsMirror && cell === BACKSLASH_MIRROR) cell = SLASH_MIRROR;
      if (vertical && cell === TOP_KING) cell = BOTTOM_KING;
      else if (vertical && cell === BOTTOM_KING) cell = TOP_KING;
      transformed[nextRow][nextCol] = cell;
    }
  }
  return transformed;
}

/** Reflect laser sources into the same canonical board orientation. */
function transformedSources(sources, horizontal, vertical) {
  return sources.map(([row, col, direction]) => {
    const [nextRow, nextCol] = transformedPosition(row, col, horizontal, vertical);
    let nextDirection = direction;
    if (horizontal) nextDirection = HORIZONTAL_DIRECTION[nextDirection];
    if (vertical) nextDirection = VERTICAL_DIRECTION[nextDirection];
    return [nextRow, nextCol, nextDirection];
  });
}

/** Reflect the no-turn set alongside its board. */
function transformedForbidden(forbiddenTurns, horizontal, vertical) {
  return new Set([...forbiddenTurns].map((square) => {
    const [row, col] = square.split(",").map(Number);
    return transformedPosition(row, col, horizontal, vertical).join(",");
  }));
}

/** Reflect one witness bit mask into or out of canonical orientation. */
function transformedMask(mask, horizontal, vertical) {
  let transformed = 0n;
  for (let index = 0; index < BOARD_SIZE * BOARD_SIZE; index += 1) {
    if (!(mask & (1n << BigInt(index)))) continue;
    const row = Math.floor(index / BOARD_SIZE);
    const col = index % BOARD_SIZE;
    const [nextRow, nextCol] = transformedPosition(row, col, horizontal, vertical);
    transformed |= 1n << BigInt(nextRow * BOARD_SIZE + nextCol);
  }
  return transformed;
}

/** Return the lexicographically stable equivalent route problem. */
function canonicalProblem(board, sources, forbiddenTurns) {
  const candidates = [];
  for (const horizontal of [false, true]) {
    for (const vertical of [false, true]) {
      const candidateBoard = transformedBoard(board, horizontal, vertical);
      candidates.push({
        board: candidateBoard,
        sources: transformedSources(sources, horizontal, vertical),
        forbiddenTurns: transformedForbidden(forbiddenTurns, horizontal, vertical),
        horizontal,
        vertical,
        key: candidateBoard.map((row) => row.join("")).join(""),
      });
    }
  }
  candidates.sort((left, right) => left.key.localeCompare(right.key));
  return candidates[0];
}

/** Return a canonical witness to the caller's original board orientation. */
function originalWitness(witness, horizontal, vertical) {
  if (!witness) return null;
  const swapsMirror = horizontal !== vertical;
  return {
    empty: transformedMask(witness.empty, horizontal, vertical),
    slash: transformedMask(
      swapsMirror ? witness.backslash : witness.slash,
      horizontal,
      vertical,
    ),
    backslash: transformedMask(
      swapsMirror ? witness.slash : witness.backslash,
      horizontal,
      vertical,
    ),
  };
}

/** Own one isolated SAT formula so unrelated route queries cannot poison it. */
class SatFormula {
  constructor() {
    this.solver = new MiniSat();
    this.nextVariable = 1;
  }

  /** Allocate one positive MiniSat variable number. */
  newVariable() {
    const variable = this.nextVariable;
    this.nextVariable += 1;
    return variable;
  }

  /** Add one clause to this board and target pairing. */
  addClause(literals) {
    this.solver.addClause(literals);
  }

  /** Require exactly one literal using a compact pairwise encoding. */
  exactlyOne(variables) {
    this.addClause(variables);
    this.atMostOne(variables);
  }

  /** Forbid every pair of simultaneously selected literals. */
  atMostOne(variables) {
    for (let left = 0; left < variables.length; left += 1) {
      for (let right = left + 1; right < variables.length; right += 1) {
        this.addClause([-variables[left], -variables[right]]);
      }
    }
  }

  /** Solve this isolated route formula and return its assignment. */
  solve() {
    this.solver.ensureVar(this.nextVariable - 1);
    return this.solver.solve() ? this.solver.getSolution() : null;
  }
}

/** Build one beam's conditional graph and unit-flow constraints. */
function addBeamFlow(formula, board, sources, forbiddenTurns, beamIndex, target, mirrors, edgeSteps) {
  const incoming = new Map();
  const outgoing = new Map();
  const sourceEdges = [];
  const targetEdges = [];

  const addEdge = (from, to, conditions, step) => {
    const variable = formula.newVariable();
    if (from === "source") sourceEdges.push(variable);
    else {
      if (!outgoing.has(from)) outgoing.set(from, []);
      outgoing.get(from).push(variable);
    }
    if (to === "target") targetEdges.push(variable);
    else {
      if (!incoming.has(to)) incoming.set(to, []);
      incoming.get(to).push(variable);
    }
    for (const condition of conditions) formula.addClause([-variable, condition]);
    if (step) edgeSteps.set(variable, step);
  };

  const addTransitions = (from, row, col, direction) => {
    const [dr, dc] = DIRECTIONS[direction];
    const nextRow = row + dr;
    const nextCol = col + dc;
    if (nextRow < 0 || nextRow >= BOARD_SIZE || nextCol < 0 || nextCol >= BOARD_SIZE) return;

    const cell = board[nextRow][nextCol];
    const destination = (nextDirection) => stateKey(nextRow, nextCol, nextDirection);
    const addStep = (to, conditions = [], orientation = null) => {
      addEdge(
        from,
        to,
        conditions,
        orientation ? { row: nextRow, col: nextCol, orientation } : null,
      );
    };

    if (cell === TOP_KING || cell === BOTTOM_KING) {
      const hit = cell === TOP_KING ? "top" : "bottom";
      if (hit === target) addStep("target");
      return;
    }
    if (cell === SLASH_MIRROR) {
      addStep(destination(SLASH_TURN[direction]), [], SLASH_MIRROR);
      return;
    }
    if (cell === BACKSLASH_MIRROR) {
      addStep(destination(BACKSLASH_TURN[direction]), [], BACKSLASH_MIRROR);
      return;
    }
    if (cell !== EMPTY && cell !== SHIELD) return;

    const { slash, backslash } = mirrors.get(squareKey(nextRow, nextCol));
    addStep(destination(direction), [-slash, -backslash], EMPTY);
    if (!forbiddenTurns.has(squareKey(nextRow, nextCol))) {
      addStep(destination(SLASH_TURN[direction]), [slash], SLASH_MIRROR);
      addStep(destination(BACKSLASH_TURN[direction]), [backslash], BACKSLASH_MIRROR);
    }
  };

  const [sourceRow, sourceCol, sourceDirection] = sources[beamIndex];
  addTransitions("source", sourceRow, sourceCol, sourceDirection);
  for (let row = 0; row < BOARD_SIZE; row += 1) {
    for (let col = 0; col < BOARD_SIZE; col += 1) {
      for (const direction of Object.keys(DIRECTIONS)) {
        addTransitions(stateKey(row, col, direction), row, col, direction);
      }
    }
  }

  formula.exactlyOne(sourceEdges);
  formula.exactlyOne(targetEdges);
  const nodes = new Set([...incoming.keys(), ...outgoing.keys()]);
  for (const node of nodes) {
    const entering = incoming.get(node) || [];
    const leaving = outgoing.get(node) || [];
    formula.atMostOne(entering);
    formula.atMostOne(leaving);
    for (const edge of entering) formula.addClause([-edge, ...leaving]);
    for (const edge of leaving) formula.addClause([-edge, ...entering]);
  }
}

/** Convert one satisfying pair of beam flows into a reusable route witness. */
function witnessFromSolution(solution, edgeSteps) {
  let empty = 0n;
  let slash = 0n;
  let backslash = 0n;
  for (const [edge, step] of edgeSteps) {
    if (!solution[edge]) continue;
    const bit = 1n << BigInt(step.row * BOARD_SIZE + step.col);
    if (step.orientation === EMPTY) empty |= bit;
    else if (step.orientation === SLASH_MIRROR) slash |= bit;
    else backslash |= bit;
  }
  return { empty, slash, backslash };
}

/** Solve one assignment of the two lasers to different kings exactly. */
function exactPairingWitness(board, sources, forbiddenTurns, targets) {
  const formula = new SatFormula();
  const mirrors = new Map();
  for (let row = 0; row < BOARD_SIZE; row += 1) {
    for (let col = 0; col < BOARD_SIZE; col += 1) {
      if (board[row][col] !== EMPTY && board[row][col] !== SHIELD) continue;
      const variables = {
        slash: formula.newVariable(),
        backslash: formula.newVariable(),
      };
      mirrors.set(squareKey(row, col), variables);
      formula.atMostOne([variables.slash, variables.backslash]);
    }
  }

  const edgeSteps = new Map();
  addBeamFlow(formula, board, sources, forbiddenTurns, 0, targets[0], mirrors, edgeSteps);
  addBeamFlow(formula, board, sources, forbiddenTurns, 1, targets[1], mirrors, edgeSteps);
  const solution = formula.solve();
  return solution ? witnessFromSolution(solution, edgeSteps) : null;
}

/** Return an unrestricted compatible-route witness for opposite king targets. */
export function exactJointPathWitness(board, sources, forbiddenTurns) {
  const canonical = canonicalProblem(board, sources, forbiddenTurns);
  const witness = exactPairingWitness(
    canonical.board,
    canonical.sources,
    canonical.forbiddenTurns,
    ["top", "bottom"],
  ) || exactPairingWitness(
    canonical.board,
    canonical.sources,
    canonical.forbiddenTurns,
    ["bottom", "top"],
  );
  return originalWitness(witness, canonical.horizontal, canonical.vertical);
}
