import MiniSat from "./minisat.js?v=0.13.0";

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
const MAX_INCREMENTAL_FORMULAS = 96;

let solver = null;
let nextVariable = 1;
let formulaCount = 0;

function squareKey(row, col) {
  return `${row},${col}`;
}

function stateKey(row, col, direction) {
  return `${row},${col},${direction}`;
}

/** Reset the incremental solver before inactive formulas become excessive. */
function ensureSolver() {
  if (!solver || formulaCount >= MAX_INCREMENTAL_FORMULAS) {
    solver = new MiniSat();
    nextVariable = 1;
    formulaCount = 0;
  }
}

/** Allocate one positive MiniSat variable number. */
function newVariable() {
  const variable = nextVariable;
  nextVariable += 1;
  return variable;
}

/** Own one activation-guarded formula in the shared incremental solver. */
class SatFormula {
  constructor() {
    ensureSolver();
    this.activation = newVariable();
    formulaCount += 1;
  }

  /** Add a clause that is active only for this board and target pairing. */
  addClause(literals) {
    solver.addClause([-this.activation, ...literals]);
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

  /** Solve only this formula while retaining learned clauses globally. */
  solve() {
    solver.ensureVar(nextVariable - 1);
    const solution = solver.solveAssuming(this.activation) ? solver.getSolution() : null;
    solver.retireVar(this.activation);
    return solution;
  }
}

/** Build one beam's conditional graph and unit-flow constraints. */
function addBeamFlow(formula, board, sources, forbiddenTurns, beamIndex, target, mirrors, edgeSteps) {
  const incoming = new Map();
  const outgoing = new Map();
  const sourceEdges = [];
  const targetEdges = [];

  const addEdge = (from, to, conditions, step) => {
    const variable = newVariable();
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
      const variables = { slash: newVariable(), backslash: newVariable() };
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
  return exactPairingWitness(board, sources, forbiddenTurns, ["top", "bottom"])
    || exactPairingWitness(board, sources, forbiddenTurns, ["bottom", "top"]);
}
