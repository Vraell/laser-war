from __future__ import annotations

import random
from dataclasses import dataclass
from math import inf
from threading import Event
from time import monotonic

from .engine import TURNS, Cell, Game, Move, State

MATE_SCORE = 10_000


@dataclass(frozen=True)
class DifficultyProfile:
    label: str
    time_limit: float
    max_depth: int
    candidate_spread: int = 1
    root_limit: int | None = None
    branch_limits: tuple[int, ...] = ()


DIFFICULTIES = {
    "easy": DifficultyProfile("Easy", 0.20, 1, 5),
    "medium": DifficultyProfile("Medium", 1.25, 3, 1),
    "hard": DifficultyProfile("Hard", 3.50, 5, 1),
    "ultra": DifficultyProfile("Ultra", 6.0, 10, 1, 24, (22, 12, 8)),
}


@dataclass(frozen=True)
class SearchResult:
    move: Move | None
    score: float
    depth: int
    nodes: int
    elapsed: float


class SearchInterrupted(Exception):
    pass


class ComputerAI:
    def __init__(self, game: Game, seed: int | None = None):
        """Initialize reusable search state for one game engine."""
        self.game = game
        self.random = random.Random(seed)
        self.deadline = inf
        self.cancel_event: Event | None = None
        self.nodes = 0
        self.ordering: dict[State, Move] = {}
        self.history: dict[Move, int] = {}
        self.killers: dict[int, list[Move]] = {}
        self.cache: dict[tuple[State, int], float] = {}
        self.children_cache: dict[State, list[tuple[Move, State]]] = {}
        self.profile = DIFFICULTIES["medium"]

    def choose_move(
        self,
        state: State,
        difficulty: str = "medium",
        cancel_event: Event | None = None,
    ) -> SearchResult:
        """Choose a legal move with iterative deepening under the selected budget."""
        profile = DIFFICULTIES.get(difficulty, DIFFICULTIES["medium"])
        self.profile = profile
        started = monotonic()
        self.deadline = started + profile.time_limit
        soft_deadline, late_position = self._soft_deadline(state, started)
        self.cancel_event = cancel_event
        self.nodes = 0
        self.ordering.clear()
        self.history.clear()
        self.killers.clear()
        self.cache.clear()
        self.children_cache.clear()

        children = self.game.legal_children(state)
        if not children:
            return SearchResult(None, self.game.evaluate(state), 0, self.nodes, monotonic() - started)
        self.children_cache[state] = children
        legal = [move for move, _child in children]

        best_move = legal[0]
        best_score = -inf
        completed_depth = 0
        ranked: list[tuple[float, Move]] = []

        for depth in range(1, profile.max_depth + 1):
            iteration_started = monotonic()
            configured_deadline = self.deadline
            if depth == 1:
                self.deadline = inf
            try:
                score, move, iteration_ranked = self._search_root(state, depth, legal)
            except SearchInterrupted:
                break
            finally:
                self.deadline = configured_deadline
            best_move = move
            best_score = score
            ranked = iteration_ranked
            completed_depth = depth
            self.ordering[state] = move
            iteration_elapsed = monotonic() - iteration_started
            now = monotonic()
            if abs(best_score) >= MATE_SCORE - 100:
                break
            if depth >= 3 and (
                now >= soft_deadline
                or (not late_position and now + max(0.05, iteration_elapsed * 1.8) >= soft_deadline)
            ):
                break

        if profile.candidate_spread > 1 and ranked:
            candidates = ranked[: min(profile.candidate_spread, len(ranked))]
            best_score, best_move = self.random.choice(candidates)

        return SearchResult(best_move, best_score, completed_depth, self.nodes, monotonic() - started)

    def _search_root(
        self,
        state: State,
        depth: int,
        legal: list[Move],
    ) -> tuple[float, Move, list[tuple[float, Move]]]:
        """Score and rank root moves for one completed search depth."""
        alpha = -inf
        beta = inf
        ranked: list[tuple[float, Move]] = []
        ordered = self._ordered_children(state, legal, ply=0)
        if depth >= 3 and self.profile.root_limit is not None:
            ordered = ordered[: self.profile.root_limit]

        for move, child in ordered:
            self._check_interrupted()
            score = -self._negamax(child, depth - 1, -beta, -alpha, ply=1)
            ranked.append((score, move))
            alpha = max(alpha, score)

        ranked.sort(key=lambda item: item[0], reverse=True)
        score, move = ranked[0]
        return score, move, ranked

    def _negamax(self, state: State, depth: int, alpha: float, beta: float, *, ply: int) -> float:
        """Evaluate a subtree with alpha-beta negamax and move-order caches."""
        self._check_interrupted()
        self.nodes += 1
        if state.winner:
            score = self.game.evaluate(state)
            return score - ply if score > 0 else score + ply
        if state.draw:
            return 0
        if depth <= 0:
            return self._stabilized_evaluation(state, ply)

        cache_key = (state, depth)
        cached = self.cache.get(cache_key)
        if cached is not None:
            return cached

        children = self._ordered_children(state, ply=ply)
        if not children:
            return 0
        branch_limit = self._branch_limit(ply)
        if branch_limit is not None:
            children = children[:branch_limit]

        value = -inf
        cutoff = False
        best_move: Move | None = None
        for move, child in children:
            score = -self._negamax(child, depth - 1, -beta, -alpha, ply=ply + 1)
            if score > value:
                value = score
                best_move = move
            alpha = max(alpha, value)
            if alpha >= beta:
                cutoff = True
                self.history[move] = self.history.get(move, 0) + depth * depth
                killers = self.killers.setdefault(ply, [])
                if move not in killers:
                    killers.insert(0, move)
                    del killers[2:]
                break

        if best_move is not None:
            self.ordering[state] = best_move
        if not cutoff:
            self.cache[cache_key] = value
        return value

    def _ordered_children(
        self,
        state: State,
        moves: list[Move] | None = None,
        *,
        ply: int = 0,
    ) -> list[tuple[Move, State]]:
        """Return legal children ordered by tactical and historical priority."""
        children = self.children_cache.get(state)
        if children is None:
            children = self.game.legal_children(state, check_joint_paths=False)
            if moves is not None:
                legal = set(moves)
                children = [item for item in children if item[0] in legal]
            self.children_cache[state] = children

        preferred = self.ordering.get(state)
        killers = self.killers.get(ply, [])
        return sorted(
            children,
            key=lambda item: self._move_priority(state, item[0], item[1], preferred, killers),
            reverse=True,
        )

    def _move_priority(
        self,
        state: State,
        move: Move,
        child: State,
        preferred: Move | None,
        killers: list[Move],
    ) -> float:
        """Rank a child for search ordering without changing its game value."""
        if child.winner == state.turn:
            return 1_000_000
        if child.draw:
            terminal = 0
        elif child.winner:
            return -1_000_000
        else:
            terminal = -self.game.evaluate(child) * 1_000

        adjacent_mirrors = 0
        for row in range(max(0, move.row - 1), min(self.game.size, move.row + 2)):
            for col in range(max(0, move.col - 1), min(self.game.size, move.col + 2)):
                if state.board[row][col] in (Cell.MIRROR_SLASH, Cell.MIRROR_BACKSLASH):
                    adjacent_mirrors += 1

        principal = 100_000 if move == preferred else 0
        killer = 50_000 - killers.index(move) * 5_000 if move in killers else 0
        return principal + killer + terminal + self.history.get(move, 0) + adjacent_mirrors * 20

    def _stabilized_evaluation(self, state: State, ply: int) -> float:
        """Extend exposed-king horizons through all legal tactical evasions."""
        score = self._strategic_evaluation(state)
        if not any(beam.hit_king for beam in self.game.fire_lasers(state.board)):
            return score

        children = self._ordered_children(state, ply=ply)
        if not children:
            return 0
        opponent = TURNS[state.turn]
        best = -inf
        for _move, child in children:
            self._check_interrupted()
            self.nodes += 1
            if child.winner == state.turn:
                return MATE_SCORE - (ply + 1)
            if child.winner == opponent:
                continue
            candidate = 0 if child.draw else -self._strategic_evaluation(child)
            best = max(best, candidate)
        return -MATE_SCORE + (ply + 1) if best == -inf else best

    def _strategic_evaluation(self, state: State) -> float:
        """Score shield shape, live beam pressure, and route resilience."""
        score = self.game.evaluate(state)
        own = state.turn
        opponent = TURNS[own]
        own_king = Cell.TOP_KING if own == "top" else Cell.BOTTOM_KING
        opponent_king = Cell.BOTTOM_KING if own == "top" else Cell.TOP_KING
        score += self._shield_structure(state, own_king) - self._shield_structure(state, opponent_king)

        reachable = self.game.reachable_kings_by_laser(state.board)
        attack_routes = sum(opponent in kings for kings in reachable)
        exposed_routes = sum(own in kings for kings in reachable)
        score += (attack_routes - exposed_routes) * 18

        hit_kings = {beam.hit_king for beam in self.game.fire_lasers(state.board) if beam.hit_king}
        if opponent in hit_kings:
            score += 240
        if own in hit_kings:
            score -= 240
        return score

    def _shield_structure(self, state: State, king: Cell) -> float:
        """Weight close shields more heavily than loose outer protection."""
        king_position = next(
            ((row, col) for row, cells in enumerate(state.board) for col, cell in enumerate(cells) if cell == king),
            None,
        )
        if king_position is None:
            return 0
        king_row, king_col = king_position
        score = 0.0
        for row, cells in enumerate(state.board):
            for col, cell in enumerate(cells):
                if cell != Cell.SHIELD:
                    continue
                distance = max(abs(row - king_row), abs(col - king_col))
                if distance == 1:
                    score += 18
                elif distance == 2:
                    score += 6
        return score

    def _branch_limit(self, ply: int) -> int | None:
        """Return the configured selective-search width for a ply."""
        if not self.profile.branch_limits:
            return None
        index = min(max(0, ply - 1), len(self.profile.branch_limits) - 1)
        return self.profile.branch_limits[index]

    def _soft_deadline(self, state: State, started: float) -> tuple[float, bool]:
        """Choose a responsive think target while preserving Ultra's hard cap."""
        if self.profile.label != "Ultra":
            return self.deadline, False
        mirrors = sum(
            cell in (Cell.MIRROR_SLASH, Cell.MIRROR_BACKSLASH)
            for row in state.board
            for cell in row
        )
        late_position = mirrors >= 31
        soft_limit = 6.0 if late_position else 3.5 if mirrors >= 12 else 2.25
        return min(self.deadline, started + soft_limit), late_position

    def _check_interrupted(self) -> None:
        """Abort promptly when the search deadline or cancellation flag is reached."""
        if monotonic() >= self.deadline or (self.cancel_event and self.cancel_event.is_set()):
            raise SearchInterrupted
