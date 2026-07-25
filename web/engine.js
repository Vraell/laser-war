export const BOARD_SIZE = 9;
export const MIDDLE_ROW = 4;

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

function key(row, col) {
  return `${row},${col}`;
}

function cloneBoard(board) {
  return board.map((row) => [...row]);
}

function cloneState(state) {
  return {
    board: cloneBoard(state.board),
    turn: state.turn,
    winner: state.winner,
    draw: state.draw,
  };
}

export class Game {
  constructor() {
    this.sources = [
      [MIDDLE_ROW, -1, "E"],
      [MIDDLE_ROW, BOARD_SIZE, "W"],
    ];
    this.noMirrorSquares = new Set([key(MIDDLE_ROW, 0), key(MIDDLE_ROW, BOARD_SIZE - 1)]);
    this.reachabilityCache = new Map();
  }

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
    const moves = [];
    for (const move of this.pseudoMoves(state)) {
      if (this.isLegalMove(state, move)) moves.push(move);
    }
    return moves;
  }

  isLegalMove(state, move) {
    try {
      this.resolveMove(state, move, false);
      return true;
    } catch {
      return false;
    }
  }

  resolveMove(state, move, checkNoLegalMoves = true) {
    if (state.winner || state.draw) throw new Error("The game is already over.");
    if (![Cell.SLASH, Cell.BACKSLASH].includes(move.mirror)) {
      throw new Error("A move must place a mirror.");
    }
    if (!this.inBounds(move.row, move.col)) throw new Error("Move is outside the board.");
    const forbidden = this.mirrorForbiddenSquares(state.board);
    if (forbidden.has(key(move.row, move.col))) {
      if (this.noMirrorSquares.has(key(move.row, move.col))) {
        throw new Error("No mirror can be placed directly in front of a laser.");
      }
      throw new Error("No mirror can be placed adjacent to a king.");
    }
    if (state.board[move.row][move.col] !== Cell.EMPTY) throw new Error("Move square is not empty.");

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
    let nextState;
    if (hitKings.has(own) && hitKings.has(opponent)) {
      nextState = { board: damaged, turn: opponent, winner: null, draw: true };
    } else if (hitKings.has(opponent)) {
      nextState = { board: damaged, turn: opponent, winner: own, draw: false };
    } else if (hitKings.has(own)) {
      nextState = { board: damaged, turn: opponent, winner: opponent, draw: false };
    } else {
      const reachable = this.reachableKingsByLaser(damaged);
      if (!reachable.some((kings) => kings.has(own))) {
        throw new Error("That move blocks every possible laser path to your king.");
      }
      if (!reachable.some((kings) => kings.has(opponent))) {
        throw new Error("That move blocks every possible laser path to the opposing king.");
      }
      for (let index = 0; index < reachable.length; index += 1) {
        if (!reachable[index].size) {
          throw new Error(`That move strands the ${index === 0 ? "left" : "right"} laser.`);
        }
      }
      nextState = { board: damaged, turn: opponent, winner: null, draw: false };
      if (checkNoLegalMoves && !this.hasAnyLegalMove(nextState)) nextState.draw = true;
    }

    return { state: nextState, beams, destroyed, hitKings };
  }

  hasAnyLegalMove(state) {
    for (const move of this.pseudoMoves(state)) {
      if (this.isLegalMove(state, move)) return true;
    }
    return false;
  }

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
    return new Set([...this.noMirrorSquares, ...this.kingAdjacentSquares(board)]);
  }

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
    return this.sources.map((source) => this.traceBeam(board, source));
  }

  traceBeam(board, source) {
    let [row, col, direction] = source;
    const visited = new Set();
    const path = [];
    while (true) {
      const [dr, dc] = DIRS[direction];
      row += dr;
      col += dc;
      if (!this.inBounds(row, col)) {
        return { path, hitShield: null, hitKing: null, exited: true, looped: false };
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

  reachableKingsByLaser(board) {
    const boardKey = board.map((row) => row.join("")).join("");
    if (this.reachabilityCache.has(boardKey)) return this.reachabilityCache.get(boardKey);
    const reachable = this.sources.map((source) => this.reachableKings(board, source));
    this.reachabilityCache.set(boardKey, reachable);
    if (this.reachabilityCache.size > 4096) {
      this.reachabilityCache.delete(this.reachabilityCache.keys().next().value);
    }
    return reachable;
  }

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
}

function scoreForTop(game, state) {
  return state.turn === "top" ? game.evaluate(state) : -game.evaluate(state);
}

export function chooseComputerMove(game, state, difficulty = "medium") {
  const started = performance.now();
  const legal = game.legalMoves(state);
  if (!legal.length) return { move: null, score: 0, nodes: 0, elapsed: 0 };
  let nodes = 0;
  const ranked = legal.map((move) => {
    const child = game.resolveMove(state, move, false).state;
    nodes += 1;
    return { move, state: child, score: scoreForTop(game, child) };
  }).sort((left, right) => right.score - left.score);

  if (difficulty === "easy") {
    const pool = ranked.slice(0, Math.min(8, ranked.length));
    const picked = pool[Math.floor(Math.random() * pool.length)];
    return { move: picked.move, score: picked.score, nodes, elapsed: performance.now() - started };
  }

  const deadline = started + (difficulty === "hard" ? 500 : 140);
  const minimumCandidates = difficulty === "hard" ? 24 : 6;
  const analyzed = [];
  for (const candidate of ranked) {
    if (candidate.state.winner === "top") {
      return { move: candidate.move, score: 10000, nodes, elapsed: performance.now() - started };
    }
    if (candidate.state.winner || candidate.state.draw) {
      analyzed.push(candidate);
      continue;
    }
    if (performance.now() >= deadline && analyzed.length >= 1) break;
    let worstReply = Infinity;
    let complete = true;
    const replies = game.legalMoves(candidate.state);
    if (!replies.length) worstReply = 0;
    for (const reply of replies) {
      if (performance.now() >= deadline && analyzed.length >= 1) {
        complete = false;
        break;
      }
      const replyState = game.resolveMove(candidate.state, reply, false).state;
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
    return { move: picked.move, score: picked.score, nodes, elapsed: performance.now() - started };
  }

  if (!analyzed.length) {
    for (const candidate of ranked.slice(0, 3)) {
      const replies = game.legalMoves(candidate.state);
      if (replies.some((reply) => game.resolveMove(candidate.state, reply, false).state.winner === "bottom")) {
        candidate.score = -10000;
      }
    }
    ranked.sort((left, right) => right.score - left.score);
  }

  const poolSize = Math.min(3, ranked.length);
  const picked = ranked[Math.floor(Math.random() * poolSize)];
  return { move: picked.move, score: picked.score, nodes, elapsed: performance.now() - started };
}

export { cloneState };
