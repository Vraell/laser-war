from __future__ import annotations

from collections.abc import Iterable
from dataclasses import dataclass
from enum import Enum
from math import inf

BOARD_SIZE = 9
MIDDLE_ROW = 4
NO_MIRROR_SQUARES = frozenset({(MIDDLE_ROW, 0), (MIDDLE_ROW, BOARD_SIZE - 1)})

DIRS = {
    "N": (-1, 0),
    "E": (0, 1),
    "S": (1, 0),
    "W": (0, -1),
}

SLASH = {
    "N": "E",
    "E": "N",
    "S": "W",
    "W": "S",
}

BACKSLASH = {
    "N": "W",
    "W": "N",
    "S": "E",
    "E": "S",
}

TURNS = {
    "top": "bottom",
    "bottom": "top",
}


class Cell(str, Enum):
    EMPTY = "."
    MIRROR_SLASH = "/"
    MIRROR_BACKSLASH = "\\"
    TOP_KING = "k"
    BOTTOM_KING = "K"
    SHIELD = "O"


@dataclass(frozen=True)
class Move:
    row: int
    col: int
    mirror: Cell


@dataclass(frozen=True)
class BeamResult:
    path: tuple[tuple[int, int, str], ...]
    hit_shield: tuple[int, int] | None = None
    hit_king: str | None = None
    exited: bool = False
    looped: bool = False


@dataclass(frozen=True)
class State:
    board: tuple[tuple[Cell, ...], ...]
    turn: str = "bottom"
    winner: str | None = None
    draw: bool = False


@dataclass(frozen=True)
class MoveOutcome:
    state: State
    beams: tuple[BeamResult, BeamResult]
    destroyed: tuple[tuple[int, int], ...]
    hit_kings: frozenset[str]


class Game:
    def __init__(self, size: int = BOARD_SIZE):
        if size != 9:
            raise ValueError("This reconstruction currently supports only the 9x9 board.")
        self.size = size
        self.sources = ((MIDDLE_ROW, -1, "E"), (MIDDLE_ROW, size, "W"))
        self.no_mirror_squares = NO_MIRROR_SQUARES

    def initial_state(self, turn: str = "bottom") -> State:
        board = [[Cell.EMPTY for _ in range(self.size)] for _ in range(self.size)]

        board[0][4] = Cell.TOP_KING
        for r, c in ((0, 3), (0, 5), (1, 3), (1, 4), (1, 5), (2, 4)):
            board[r][c] = Cell.SHIELD

        board[8][4] = Cell.BOTTOM_KING
        for r, c in ((8, 3), (8, 5), (7, 3), (7, 4), (7, 5), (6, 4)):
            board[r][c] = Cell.SHIELD

        return State(self._freeze(board), turn=turn)

    def legal_moves(self, state: State) -> list[Move]:
        return [move for move in self._pseudo_moves(state) if self.is_legal_move(state, move)]

    def is_legal_move(self, state: State, move: Move) -> bool:
        try:
            self.resolve_move(state, move, check_no_legal_moves=False)
        except ValueError:
            return False
        return True

    def apply_move(self, state: State, move: Move) -> State:
        return self.resolve_move(state, move).state

    def resolve_move(self, state: State, move: Move, check_no_legal_moves: bool = True) -> MoveOutcome:
        if state.winner or state.draw:
            raise ValueError("The game is already over.")
        if move.mirror not in (Cell.MIRROR_SLASH, Cell.MIRROR_BACKSLASH):
            raise ValueError("A move must place either '/' or '\\'.")
        if not self._in_bounds(move.row, move.col):
            raise ValueError("Move is outside the board.")
        if (move.row, move.col) in self.mirror_forbidden_squares(state.board):
            if (move.row, move.col) in self.no_mirror_squares:
                raise ValueError("No mirror can be placed directly in front of a laser.")
            raise ValueError("No mirror can be placed adjacent to a king.")
        if state.board[move.row][move.col] != Cell.EMPTY:
            raise ValueError("Move square is not empty.")

        board = [list(row) for row in state.board]
        board[move.row][move.col] = move.mirror
        placed = self._freeze(board)

        beams = self.fire_lasers(placed)
        damaged = [list(row) for row in placed]
        hit_kings = frozenset(result.hit_king for result in beams if result.hit_king)
        destroyed = tuple(result.hit_shield for result in beams if result.hit_shield)

        for r, c in destroyed:
            damaged[r][c] = Cell.EMPTY

        next_board = self._freeze(damaged)
        own = state.turn
        opponent = TURNS[own]

        if own in hit_kings and opponent in hit_kings:
            next_state = State(next_board, turn=opponent, draw=True)
        elif opponent in hit_kings:
            next_state = State(next_board, turn=opponent, winner=own)
        elif own in hit_kings:
            next_state = State(next_board, turn=opponent, winner=opponent)
        else:
            if not self.has_possible_path_to_king(next_board, own):
                raise ValueError("Illegal move: it fully blocks all possible laser paths to your king.")
            if not self.has_possible_path_to_king(next_board, opponent):
                raise ValueError("Illegal move: it fully blocks all possible laser paths to the opponent's king.")
            if check_no_legal_moves:
                provisional = State(next_board, turn=opponent)
                next_state = State(next_board, turn=opponent, draw=not self.has_any_legal_move(provisional))
            else:
                next_state = State(next_board, turn=opponent)

        return MoveOutcome(next_state, beams, destroyed, hit_kings)

    def has_any_legal_move(self, state: State) -> bool:
        return any(self.is_legal_move(state, move) for move in self._pseudo_moves(state))

    def fire_lasers(self, board: tuple[tuple[Cell, ...], ...]) -> tuple[BeamResult, BeamResult]:
        return tuple(self._trace_beam(board, source) for source in self.sources)  # type: ignore[return-value]

    def best_move(self, state: State, depth: int = 2) -> tuple[Move | None, float]:
        moves = self.legal_moves(state)
        if not moves:
            return None, self.evaluate(state)

        best = None
        best_score = -inf
        alpha = -inf
        beta = inf
        for move in moves:
            child = self.resolve_move(state, move, check_no_legal_moves=False).state
            score = -self._search(child, depth - 1, -beta, -alpha)
            if score > best_score:
                best = move
                best_score = score
            alpha = max(alpha, score)
        return best, best_score

    def king_adjacent_squares(self, board: tuple[tuple[Cell, ...], ...]) -> frozenset[tuple[int, int]]:
        squares = set()
        kings = (Cell.TOP_KING, Cell.BOTTOM_KING)
        for row in range(self.size):
            for col in range(self.size):
                if board[row][col] not in kings:
                    continue
                for adjacent_row in range(max(0, row - 1), min(self.size, row + 2)):
                    for adjacent_col in range(max(0, col - 1), min(self.size, col + 2)):
                        if (adjacent_row, adjacent_col) != (row, col):
                            squares.add((adjacent_row, adjacent_col))
        return frozenset(squares)

    def mirror_forbidden_squares(self, board: tuple[tuple[Cell, ...], ...]) -> frozenset[tuple[int, int]]:
        return self.no_mirror_squares | self.king_adjacent_squares(board)

    def evaluate(self, state: State) -> float:
        if state.draw:
            return 0
        if state.winner == state.turn:
            return 10_000
        if state.winner == TURNS.get(state.turn):
            return -10_000

        own_king = Cell.BOTTOM_KING if state.turn == "bottom" else Cell.TOP_KING
        opp_king = Cell.TOP_KING if state.turn == "bottom" else Cell.BOTTOM_KING

        own_shields = self._nearby_shields(state.board, own_king)
        opp_shields = self._nearby_shields(state.board, opp_king)
        mobility = len(list(self._pseudo_moves(state)))
        return (own_shields - opp_shields) * 25 + mobility * 0.1

    def render(self, state: State, show_coords: bool = False) -> str:
        lines = []
        if show_coords:
            lines.append("    " + " ".join(str(i) for i in range(self.size)))
        for r, row in enumerate(state.board):
            prefix = f"{r} | " if show_coords else ""
            lines.append(prefix + " ".join(cell.value for cell in row))
        status = f"turn={state.turn}"
        if state.winner:
            status += f", winner={state.winner}"
        if state.draw:
            status += ", draw=True"
        return "\n".join(lines + [status])

    def has_possible_path_to_king(self, board: tuple[tuple[Cell, ...], ...], player: str) -> bool:
        target = Cell.BOTTOM_KING if player == "bottom" else Cell.TOP_KING
        forbidden_turns = self.mirror_forbidden_squares(board)
        seen = set()
        stack = list(self.sources)

        while stack:
            r, c, direction = stack.pop()
            dr, dc = DIRS[direction]
            nr, nc = r + dr, c + dc
            if not self._in_bounds(nr, nc):
                continue
            key = (nr, nc, direction)
            if key in seen:
                continue
            seen.add(key)

            cell = board[nr][nc]
            if cell == target:
                return True
            if cell == Cell.MIRROR_SLASH:
                stack.append((nr, nc, SLASH[direction]))
            elif cell == Cell.MIRROR_BACKSLASH:
                stack.append((nr, nc, BACKSLASH[direction]))
            elif cell in (Cell.EMPTY, Cell.SHIELD):
                stack.append((nr, nc, direction))
                if (nr, nc) not in forbidden_turns:
                    for next_direction in self._turns(direction):
                        stack.append((nr, nc, next_direction))
            else:
                stack.append((nr, nc, direction))
        return False

    def _trace_beam(self, board: tuple[tuple[Cell, ...], ...], source: tuple[int, int, str]) -> BeamResult:
        r, c, direction = source
        visited = set()
        path = []

        while True:
            dr, dc = DIRS[direction]
            r, c = r + dr, c + dc
            if not self._in_bounds(r, c):
                return BeamResult(tuple(path), exited=True)

            key = (r, c, direction)
            if key in visited:
                return BeamResult(tuple(path), looped=True)
            visited.add(key)
            path.append(key)

            cell = board[r][c]
            if cell == Cell.EMPTY:
                continue
            if cell == Cell.MIRROR_SLASH:
                direction = SLASH[direction]
                continue
            if cell == Cell.MIRROR_BACKSLASH:
                direction = BACKSLASH[direction]
                continue
            if cell == Cell.SHIELD:
                return BeamResult(tuple(path), hit_shield=(r, c))
            if cell == Cell.TOP_KING:
                return BeamResult(tuple(path), hit_king="top")
            if cell == Cell.BOTTOM_KING:
                return BeamResult(tuple(path), hit_king="bottom")

    def _search(self, state: State, depth: int, alpha: float, beta: float) -> float:
        if depth <= 0 or state.winner or state.draw:
            return self.evaluate(state)

        moves = self.legal_moves(state)
        if not moves:
            return self.evaluate(state)

        value = -inf
        for move in moves:
            child = self.resolve_move(state, move, check_no_legal_moves=False).state
            value = max(value, -self._search(child, depth - 1, -beta, -alpha))
            alpha = max(alpha, value)
            if alpha >= beta:
                break
        return value

    def _pseudo_moves(self, state: State) -> Iterable[Move]:
        if state.winner or state.draw:
            return
        forbidden = self.mirror_forbidden_squares(state.board)
        for r in range(self.size):
            for c in range(self.size):
                if (r, c) in forbidden:
                    continue
                if state.board[r][c] == Cell.EMPTY:
                    yield Move(r, c, Cell.MIRROR_SLASH)
                    yield Move(r, c, Cell.MIRROR_BACKSLASH)

    def _nearby_shields(self, board: tuple[tuple[Cell, ...], ...], king: Cell) -> int:
        king_pos = None
        for r in range(self.size):
            for c in range(self.size):
                if board[r][c] == king:
                    king_pos = (r, c)
                    break
            if king_pos:
                break
        if not king_pos:
            return 0
        kr, kc = king_pos
        count = 0
        for r in range(max(0, kr - 2), min(self.size, kr + 3)):
            for c in range(max(0, kc - 2), min(self.size, kc + 3)):
                if board[r][c] == Cell.SHIELD:
                    count += 1
        return count

    def _turns(self, direction: str) -> tuple[str, str]:
        if direction in ("N", "S"):
            return ("E", "W")
        return ("N", "S")

    def _in_bounds(self, row: int, col: int) -> bool:
        return 0 <= row < self.size and 0 <= col < self.size

    def _freeze(self, board: list[list[Cell]]) -> tuple[tuple[Cell, ...], ...]:
        return tuple(tuple(row) for row in board)
