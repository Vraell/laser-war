import { exactJointPathWitness } from "./exact_routes.js?v=0.11.10";

export const BOARD_SIZE = 9;
export const MIDDLE_ROW = 4;
const FAST_ROUTE_MIRRORS = 5;

export const Cell = Object.freeze({
  EMPTY: ".",
  SLASH: "/",
  BACKSLASH: "\\",
  TOP_KING: "k",
  BOTTOM_KING: "K",
  SHIELD: "O",
});

const DIRS = {
  N: [-1, 0],
  E: [0, 1],
  S: [1, 0],
  W: [0, -1],
};

const SLASH = { N: "E", E: "N", S: "W", W: "S" };
const BACKSLASH = { N: "W", W: "N", S: "E", E: "S" };
const TURNS = { top: "bottom", bottom: "top" };
const DIRECTION_INDEX = { N: 0, E: 1, S: 2, W: 3 };

function key(row, col) {
  return `${row},${col}`;
}

function cloneBoard(board) {
  return board.map((row) => [...row]);
}

/** Deep-clone the mutable board portion of a browser game state. */
function cloneState(state) {
  return {
    board: cloneBoard(state.board),
    turn: state.turn,
    winner: state.winner,
    draw: state.draw,
  };
}

function illegalMove(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

/** Push one cost-first tuple into a binary min-heap. */
function pushCost(frontier, item) {
  frontier.push(item);
  let index = frontier.length - 1;
  while (index > 0) {
    const parent = Math.floor((index - 1) / 2);
    if (frontier[parent][0] <= item[0]) break;
    frontier[index] = frontier[parent];
    index = parent;
  }
  frontier[index] = item;
}

/** Pop the lowest-cost tuple from a binary min-heap. */
function popCost(frontier) {
  const first = frontier[0];
  const tail = frontier.pop();
  if (!frontier.length) return first;
  let index = 0;
  while (true) {
    const left = index * 2 + 1;
    const right = left + 1;
    if (left >= frontier.length) break;
    const child = right < frontier.length && frontier[right][0] < frontier[left][0] ? right : left;
    if (frontier[child][0] >= tail[0]) break;
    frontier[index] = frontier[child];
    index = child;
  }
  frontier[index] = tail;
  return first;
}

export class Game {
  /** Initialize fixed laser geometry and the reachability cache. */
  constructor() {
    this.sources = [
      [MIDDLE_ROW, -1, "E"],
      [MIDDLE_ROW, BOARD_SIZE, "W"],
    ];
    this.laserEntrySquares = new Set([key(MIDDLE_ROW, 0), key(MIDDLE_ROW, BOARD_SIZE - 1)]);
    this.reachabilityCache = new Map();
    this.jointReachabilityCache = new Map();
    this.routeCostCache = new Map();
    this.beamCache = new Map();
    this.boardKeys = new WeakMap();
  }

  /** Create the symmetric opening position for a new match. */
  initialState(turn = "bottom") {
    const board = Array.from({ length: BOARD_SIZE }, () => Array(BOARD_SIZE).fill(Cell.EMPTY));
    board[0][4] = Cell.TOP_KING;
    for (const [row, col] of [[0, 3], [0, 5], [1, 3], [1, 4], [1, 5], [2, 4]]) {
      board[row][col] = Cell.SHIELD;
    }
    board[8][4] = Cell.BOTTOM_KING;
    for (const [row, col] of [[8, 3], [8, 5], [7, 3], [7, 4], [7, 5], [6, 4]]) {
      board[row][col] = Cell.SHIELD;
    }
    return { board, turn, winner: null, draw: false };
  }

  legalMoves(state) {
    return this.legalChildren(state).map(({ move }) => move);
  }

  /** Return legal moves paired with their fully resolved child states. */
  legalChildren(state, checkJointPaths = true) {
    const children = [];
    for (const move of this.pseudoMoves(state)) {
      try {
        const child = this.resolveMove(state, move, false, checkJointPaths).state;
        children.push({ move, state: child });
      } catch {
        // Pseudo moves still need king-path and laser-path validation.
      }
    }
    return children;
  }

  /** Check a move against placement, firing, and path-preservation rules. */
  isLegalMove(state, move) {
    try {
      this.resolveMove(state, move, false);
      return true;
    } catch {
      return false;
    }
  }

  /** Return a stable rejection code or null when a move is legal. */
  illegalMoveReason(state, move) {
    try {
      this.resolveMove(state, move, false);
      return null;
    } catch (error) {
      return error.code || "illegalMove";
    }
  }

  /** Place a mirror, fire both lasers, apply damage, and validate paths. */
  resolveMove(state, move, checkNoLegalMoves = true, checkJointPaths = true) {
    if (state.winner || state.draw) throw illegalMove("gameOver", "The game is already over.");
    if (![Cell.SLASH, Cell.BACKSLASH].includes(move.mirror)) {
      throw illegalMove("invalidMirror", "A move must place a mirror.");
    }
    if (!this.inBounds(move.row, move.col)) throw illegalMove("outsideBoard", "Move is outside the board.");
    const occupied = state.board[move.row][move.col];
    if (occupied !== Cell.EMPTY) {
      if ([Cell.TOP_KING, Cell.BOTTOM_KING].includes(occupied)) {
        throw illegalMove("occupiedKing", "No mirror can be placed on a king.");
      }
      if (occupied === Cell.SHIELD) {
        throw illegalMove("occupiedShield", "No mirror can be placed on a shield.");
      }
      throw illegalMove("occupied", "Move square is not empty.");
    }
    const forbidden = this.mirrorForbiddenSquares(state.board);
    if (forbidden.has(key(move.row, move.col))) {
      if (this.laserEntrySquares.has(key(move.row, move.col))) {
        throw illegalMove("laserEntry", "No mirror can be placed directly in front of a laser.");
      }
      throw illegalMove("kingAdjacent", "No mirror can be placed adjacent to a king.");
    }
    const placed = cloneBoard(state.board);
    placed[move.row][move.col] = move.mirror;
    const beams = this.fireLasers(placed);
    const damaged = cloneBoard(placed);
    const hitKings = new Set(beams.map((beam) => beam.hitKing).filter(Boolean));
    const destroyed = [];
    for (const beam of beams) {
      if (beam.hitShield && !destroyed.some(([row, col]) => row === beam.hitShield[0] && col === beam.hitShield[1])) {
        destroyed.push(beam.hitShield);
      }
    }
    for (const [row, col] of destroyed) damaged[row][col] = Cell.EMPTY;

    const own = state.turn;
    const opponent = TURNS[own];
    const reachable = this.reachableKingsByLaser(damaged);
    for (let index = 0; index < reachable.length; index += 1) {
      if (!reachable[index].size) {
        const side = index === 0 ? "left" : "right";
        throw illegalMove(`${side}LaserStranded`, `That move strands the ${side} laser.`);
      }
    }
    if (!reachable.some((kings) => kings.has(own))) {
      throw illegalMove("ownKingUnreachable", "That move blocks every possible laser path to your king.");
    }
    if (!reachable.some((kings) => kings.has(opponent))) {
      throw illegalMove("opponentKingUnreachable", "That move blocks every possible laser path to the opposing king.");
    }
    if (checkJointPaths && !this.jointPathsAvailable(damaged)) {
      throw illegalMove(
        "incompatiblePaths",
        "No compatible future mirror layout keeps both kings reachable.",
      );
    }

    let nextState;
    if (hitKings.has(own) && hitKings.has(opponent)) {
      nextState = { board: damaged, turn: opponent, winner: null, draw: true };
    } else if (hitKings.has(opponent)) {
      nextState = { board: damaged, turn: opponent, winner: own, draw: false };
    } else if (hitKings.has(own)) {
      nextState = { board: damaged, turn: opponent, winner: opponent, draw: false };
    } else {
      nextState = { board: damaged, turn: opponent, winner: null, draw: false };
      if (checkNoLegalMoves && !this.hasAnyLegalMove(nextState)) nextState.draw = true;
    }

    return { state: nextState, beams, destroyed, hitKings };
  }

  /** Return whether at least one fully valid move remains. */
  hasAnyLegalMove(state) {
    for (const move of this.pseudoMoves(state)) {
      if (this.isLegalMove(state, move)) return true;
    }
    return false;
  }

  /** Generate empty placements before expensive path validation. */
  *pseudoMoves(state) {
    if (state.winner || state.draw) return;
    const forbidden = this.mirrorForbiddenSquares(state.board);
    for (let row = 0; row < BOARD_SIZE; row += 1) {
      for (let col = 0; col < BOARD_SIZE; col += 1) {
        if (!forbidden.has(key(row, col)) && state.board[row][col] === Cell.EMPTY) {
          yield { row, col, mirror: Cell.SLASH };
          yield { row, col, mirror: Cell.BACKSLASH };
        }
      }
    }
  }

  mirrorForbiddenSquares(board) {
    return new Set([...this.laserEntrySquares, ...this.kingAdjacentSquares(board)]);
  }

  /** Derive all cells where a mirror would touch either king. */
  kingAdjacentSquares(board) {
    const squares = new Set();
    for (let row = 0; row < BOARD_SIZE; row += 1) {
      for (let col = 0; col < BOARD_SIZE; col += 1) {
        if (![Cell.TOP_KING, Cell.BOTTOM_KING].includes(board[row][col])) continue;
        for (let nextRow = Math.max(0, row - 1); nextRow < Math.min(BOARD_SIZE, row + 2); nextRow += 1) {
          for (let nextCol = Math.max(0, col - 1); nextCol < Math.min(BOARD_SIZE, col + 2); nextCol += 1) {
            if (nextRow !== row || nextCol !== col) squares.add(key(nextRow, nextCol));
          }
        }
      }
    }
    return squares;
  }

  fireLasers(board) {
    const boardKey = this.boardKey(board);
    if (this.beamCache.has(boardKey)) return this.beamCache.get(boardKey);
    const beams = this.sources.map((source) => this.traceBeam(board, source));
    this.beamCache.set(boardKey, beams);
    if (this.beamCache.size > 4096) {
      this.beamCache.delete(this.beamCache.keys().next().value);
    }
    return beams;
  }

  /** Trace one fired laser until it exits, loops, or strikes a piece. */
  traceBeam(board, source) {
    let [row, col, direction] = source;
    const visited = new Set();
    const path = [];
    while (true) {
      const [dr, dc] = DIRS[direction];
      row += dr;
      col += dc;
      if (!this.inBounds(row, col)) {
        return {
          path,
          hitShield: null,
          hitKing: null,
          exited: true,
          looped: false,
          exitDirection: direction,
        };
      }
      const beamKey = `${row},${col},${direction}`;
      if (visited.has(beamKey)) {
        return { path, hitShield: null, hitKing: null, exited: false, looped: true };
      }
      visited.add(beamKey);
      path.push([row, col, direction]);
      const cell = board[row][col];
      if (cell === Cell.EMPTY) continue;
      if (cell === Cell.SLASH) {
        direction = SLASH[direction];
        continue;
      }
      if (cell === Cell.BACKSLASH) {
        direction = BACKSLASH[direction];
        continue;
      }
      if (cell === Cell.SHIELD) {
        return { path, hitShield: [row, col], hitKing: null, exited: false, looped: false };
      }
      if (cell === Cell.TOP_KING || cell === Cell.BOTTOM_KING) {
        return {
          path,
          hitShield: null,
          hitKing: cell === Cell.TOP_KING ? "top" : "bottom",
          exited: false,
          looped: false,
        };
      }
    }
  }

  /** Return the kings each laser could reach after future placements. */
  reachableKingsByLaser(board) {
    const boardKey = this.boardKey(board);
    if (this.reachabilityCache.has(boardKey)) return this.reachabilityCache.get(boardKey);
    const reachable = this.sources.map((source) => this.reachableKings(board, source));
    this.reachabilityCache.set(boardKey, reachable);
    if (this.reachabilityCache.size > 4096) {
      this.reachabilityCache.delete(this.reachabilityCache.keys().next().value);
    }
    return reachable;
  }

  /** Check whether both lasers can reach opposite kings on one future layout. */
  jointPathsAvailable(board) {
    return this.jointPathWitnesses(board) !== null;
  }

  /** Reuse compatible parent routes when one new mirror does not conflict. */
  jointPathPreserved(parentBoard, childBoard, move) {
    const witnesses = this.jointPathWitnesses(parentBoard);
    if (witnesses) {
      const squareBit = 1n << BigInt(move.row * BOARD_SIZE + move.col);
      for (const witness of witnesses) {
        const conflicts = Boolean(witness.empty & squareBit)
          || (Boolean(witness.slash & squareBit) && move.mirror !== Cell.SLASH)
          || (Boolean(witness.backslash & squareBit) && move.mirror !== Cell.BACKSLASH);
        if (!conflicts) {
          this.cacheJointWitnesses(childBoard, [witness]);
          return true;
        }
      }
    }

    const childWitnesses = this.jointPathWitnesses(childBoard);
    if (childWitnesses) {
      const learned = childWitnesses[0];
      if (witnesses && !witnesses.some((witness) => (
        witness.empty === learned.empty
        && witness.slash === learned.slash
        && witness.backslash === learned.backslash
      ))) {
        this.cacheJointWitnesses(parentBoard, [...witnesses, learned]);
      }
      return true;
    }
    return false;
  }

  /** Prove a speculative child with cached or bounded witnesses only. */
  jointPathPreservedFast(parentBoard, childBoard, move) {
    const parentKey = this.boardKey(parentBoard);
    let witnesses = this.jointReachabilityCache.get(parentKey);
    if (witnesses === undefined) {
      const parentWitness = this.fastJointPathWitness(parentBoard);
      witnesses = parentWitness ? [parentWitness] : null;
      if (witnesses) this.cacheJointWitnesses(parentBoard, witnesses);
    }
    if (witnesses) {
      const squareBit = 1n << BigInt(move.row * BOARD_SIZE + move.col);
      for (const witness of witnesses) {
        const conflicts = Boolean(witness.empty & squareBit)
          || (Boolean(witness.slash & squareBit) && move.mirror !== Cell.SLASH)
          || (Boolean(witness.backslash & squareBit) && move.mirror !== Cell.BACKSLASH);
        if (!conflicts) {
          this.cacheJointWitnesses(childBoard, [witness]);
          return true;
        }
      }
    }

    const learned = this.fastJointPathWitness(childBoard);
    if (!learned) return false;
    this.cacheJointWitnesses(childBoard, [learned]);
    if (witnesses) this.cacheJointWitnesses(parentBoard, [...witnesses, learned]);
    return true;
  }

  /** Find one compatible witness within the bounded fast-search horizon. */
  fastJointPathWitness(board) {
    for (const targets of [
      ["top", "bottom"],
      ["bottom", "top"],
    ]) {
      const witness = this.jointPairingWitness(board, targets);
      if (witness) return witness;
    }
    return null;
  }

  /** Return cached compatible assignments or discover the first one. */
  jointPathWitnesses(board) {
    const boardKey = this.boardKey(board);
    if (this.jointReachabilityCache.has(boardKey)) return this.jointReachabilityCache.get(boardKey);
    let witness = this.fastJointPathWitness(board);
    if (!witness) {
      witness = exactJointPathWitness(board, this.sources, this.mirrorForbiddenSquares(board));
    }
    const witnesses = witness ? [witness] : null;
    this.cacheJointWitnesses(board, witnesses);
    return witnesses;
  }

  /** Store exact joint-route witnesses in the bounded engine cache. */
  cacheJointWitnesses(board, witnesses) {
    const boardKey = this.boardKey(board);
    this.jointReachabilityCache.set(boardKey, witnesses);
    if (this.jointReachabilityCache.size > 4096) {
      this.jointReachabilityCache.delete(this.jointReachabilityCache.keys().next().value);
    }
  }

  /** Return the first compatible shared route assignment, if one exists. */
  jointPathWitness(board) {
    return this.jointPathWitnesses(board)?.[0] || null;
  }

  /** Return minimum future-mirror counts from each laser to each king. */
  routeCostsByLaser(board) {
    const boardKey = this.boardKey(board);
    if (this.routeCostCache.has(boardKey)) return this.routeCostCache.get(boardKey);
    const costs = this.sources.map((source) => this.routeCosts(board, source));
    this.routeCostCache.set(boardKey, costs);
    if (this.routeCostCache.size > 4096) {
      this.routeCostCache.delete(this.routeCostCache.keys().next().value);
    }
    return costs;
  }

  /** Find shortest individual routes with cost-first graph search. */
  routeCosts(board, source) {
    const forbiddenTurns = this.mirrorForbiddenSquares(board);
    const sourceKey = `${source[0]},${source[1]},${source[2]}`;
    const distances = new Map([[sourceKey, 0]]);
    const frontier = [];
    const costs = {};
    pushCost(frontier, [0, source]);

    while (frontier.length && Object.keys(costs).length < 2) {
      const [cost, [row, col, direction]] = popCost(frontier);
      if (cost !== distances.get(`${row},${col},${direction}`)) continue;
      const [dr, dc] = DIRS[direction];
      const nextRow = row + dr;
      const nextCol = col + dc;
      if (!this.inBounds(nextRow, nextCol)) continue;

      const cell = board[nextRow][nextCol];
      if (cell === Cell.TOP_KING || cell === Cell.BOTTOM_KING) {
        const target = cell === Cell.TOP_KING ? "top" : "bottom";
        if (costs[target] === undefined) costs[target] = cost;
        continue;
      }

      const options = [];
      if (cell === Cell.SLASH) {
        options.push([SLASH[direction], cost]);
      } else if (cell === Cell.BACKSLASH) {
        options.push([BACKSLASH[direction], cost]);
      } else if (cell === Cell.EMPTY) {
        options.push([direction, cost]);
        if (!forbiddenTurns.has(key(nextRow, nextCol))) {
          for (const turned of this.turns(direction)) options.push([turned, cost + 1]);
        }
      } else if (cell === Cell.SHIELD) {
        options.push([direction, cost + 1]);
        if (!forbiddenTurns.has(key(nextRow, nextCol))) {
          for (const turned of this.turns(direction)) options.push([turned, cost + 2]);
        }
      }

      for (const [nextDirection, nextCost] of options) {
        const nextKey = `${nextRow},${nextCol},${nextDirection}`;
        if (nextCost >= (distances.get(nextKey) ?? Infinity)) continue;
        distances.set(nextKey, nextCost);
        pushCost(frontier, [nextCost, [nextRow, nextCol, nextDirection]]);
      }
    }
    return costs;
  }

  /** Find compatible route assignments for one left/right king pairing. */
  jointPairingWitness(board, targets) {
    const forbiddenTurns = this.mirrorForbiddenSquares(board);
    const leftRoutes = this.compatibleRoutes(
      board,
      forbiddenTurns,
      this.sources[0],
      targets[0],
      0n,
      0n,
      0n,
      0,
      0n,
    );
    for (const [empty, slash, backslash, mirrorCount] of leftRoutes) {
      const rightRoutes = this.compatibleRoutes(
        board,
        forbiddenTurns,
        this.sources[1],
        targets[1],
        empty,
        slash,
        backslash,
        mirrorCount,
        0n,
      );
      const result = rightRoutes.next();
      if (!result.done) {
        const [witnessEmpty, witnessSlash, witnessBackslash] = result.value;
        return {
          empty: witnessEmpty,
          slash: witnessSlash,
          backslash: witnessBackslash,
        };
      }
    }
    return null;
  }

  /** Yield shared assignments that route one laser to its assigned king. */
  *compatibleRoutes(
    board,
    forbiddenTurns,
    source,
    target,
    empty,
    slash,
    backslash,
    mirrorCount,
    visited,
  ) {
    const [row, col, direction] = source;
    const [dr, dc] = DIRS[direction];
    const nextRow = row + dr;
    const nextCol = col + dc;
    if (!this.inBounds(nextRow, nextCol)) return;

    const visitIndex = ((nextRow * BOARD_SIZE + nextCol) * 4) + DIRECTION_INDEX[direction];
    const visitBit = 1n << BigInt(visitIndex);
    if (visited & visitBit) return;
    const nextVisited = visited | visitBit;

    const cell = board[nextRow][nextCol];
    if (cell === Cell.TOP_KING || cell === Cell.BOTTOM_KING) {
      const hit = cell === Cell.TOP_KING ? "top" : "bottom";
      if (hit === target) yield [empty, slash, backslash, mirrorCount];
      return;
    }

    const squareBit = 1n << BigInt(nextRow * BOARD_SIZE + nextCol);
    const options = [];
    if (cell === Cell.SLASH) {
      options.push([SLASH[direction], empty, slash | squareBit, backslash, mirrorCount]);
    } else if (cell === Cell.BACKSLASH) {
      options.push([BACKSLASH[direction], empty, slash, backslash | squareBit, mirrorCount]);
    } else if (empty & squareBit) {
      options.push([direction, empty, slash, backslash, mirrorCount]);
    } else if (slash & squareBit) {
      options.push([SLASH[direction], empty, slash, backslash, mirrorCount]);
    } else if (backslash & squareBit) {
      options.push([BACKSLASH[direction], empty, slash, backslash, mirrorCount]);
    } else if (cell === Cell.EMPTY || cell === Cell.SHIELD) {
      options.push([direction, empty | squareBit, slash, backslash, mirrorCount]);
      if (!forbiddenTurns.has(key(nextRow, nextCol)) && mirrorCount < FAST_ROUTE_MIRRORS) {
        options.push([SLASH[direction], empty, slash | squareBit, backslash, mirrorCount + 1]);
        options.push([BACKSLASH[direction], empty, slash, backslash | squareBit, mirrorCount + 1]);
      }
    }

    for (const [nextDirection, nextEmpty, nextSlash, nextBackslash, nextCount] of options) {
      yield* this.compatibleRoutes(
        board,
        forbiddenTurns,
        [nextRow, nextCol, nextDirection],
        target,
        nextEmpty,
        nextSlash,
        nextBackslash,
        nextCount,
        nextVisited,
      );
    }
  }

  /** Explore all legal future beam turns from one laser source. */
  reachableKings(board, source) {
    const forbiddenTurns = this.mirrorForbiddenSquares(board);
    const reachable = new Set();
    const seen = new Set();
    const stack = [source];
    while (stack.length) {
      const [row, col, direction] = stack.pop();
      const [dr, dc] = DIRS[direction];
      const nextRow = row + dr;
      const nextCol = col + dc;
      if (!this.inBounds(nextRow, nextCol)) continue;
      const seenKey = `${nextRow},${nextCol},${direction}`;
      if (seen.has(seenKey)) continue;
      seen.add(seenKey);
      const cell = board[nextRow][nextCol];
      if (cell === Cell.TOP_KING) reachable.add("top");
      else if (cell === Cell.BOTTOM_KING) reachable.add("bottom");
      else if (cell === Cell.SLASH) stack.push([nextRow, nextCol, SLASH[direction]]);
      else if (cell === Cell.BACKSLASH) stack.push([nextRow, nextCol, BACKSLASH[direction]]);
      else if (cell === Cell.EMPTY || cell === Cell.SHIELD) {
        stack.push([nextRow, nextCol, direction]);
        if (!forbiddenTurns.has(key(nextRow, nextCol))) {
          for (const turn of this.turns(direction)) stack.push([nextRow, nextCol, turn]);
        }
      }
      if (reachable.size === 2) break;
    }
    return reachable;
  }

  /** Score a position from the side-to-move perspective. */
  evaluate(state) {
    if (state.draw) return 0;
    if (state.winner === state.turn) return 10000;
    if (state.winner === TURNS[state.turn]) return -10000;
    const ownKing = state.turn === "bottom" ? Cell.BOTTOM_KING : Cell.TOP_KING;
    const opponentKing = state.turn === "bottom" ? Cell.TOP_KING : Cell.BOTTOM_KING;
    let score = (this.nearbyShields(state.board, ownKing) - this.nearbyShields(state.board, opponentKing)) * 25;
    const threatened = new Set(this.fireLasers(state.board).map((beam) => beam.hitKing).filter(Boolean));
    if (threatened.has(state.turn) && threatened.has(TURNS[state.turn])) score += 150;
    else if (threatened.has(TURNS[state.turn])) score += 300;
    else if (threatened.has(state.turn)) score -= 300;
    return score;
  }

  /** Count shields in the evaluation radius around a king. */
  nearbyShields(board, king) {
    let position = null;
    for (let row = 0; row < BOARD_SIZE && !position; row += 1) {
      for (let col = 0; col < BOARD_SIZE; col += 1) {
        if (board[row][col] === king) {
          position = [row, col];
          break;
        }
      }
    }
    if (!position) return 0;
    let count = 0;
    for (let row = Math.max(0, position[0] - 2); row < Math.min(BOARD_SIZE, position[0] + 3); row += 1) {
      for (let col = Math.max(0, position[1] - 2); col < Math.min(BOARD_SIZE, position[1] + 3); col += 1) {
        if (board[row][col] === Cell.SHIELD) count += 1;
      }
    }
    return count;
  }

  turns(direction) {
    return ["N", "S"].includes(direction) ? ["E", "W"] : ["N", "S"];
  }

  inBounds(row, col) {
    return row >= 0 && row < BOARD_SIZE && col >= 0 && col < BOARD_SIZE;
  }

  /** Return a stable serialized key for an immutable search board. */
  boardKey(board) {
    let boardKey = this.boardKeys.get(board);
    if (!boardKey) {
      boardKey = board.map((row) => row.join("")).join("");
      this.boardKeys.set(board, boardKey);
    }
    return boardKey;
  }
}

export { cloneState };
