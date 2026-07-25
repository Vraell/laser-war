from __future__ import annotations

import random
from dataclasses import dataclass
from math import inf
from threading import Event
from time import monotonic

from .engine import Cell, Game, Move, State


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
    "ultra": DifficultyProfile("Ultra", 10.0, 4, 1, 24, (22, 12, 8)),
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
        self.game = game
        self.random = random.Random(seed)
        self.deadline = inf
        self.cancel_event: Event | None = None
        self.nodes = 0
        self.ordering: dict[State, Move] = {}
        self.history: dict[Move, int] = {}
        self.cache: dict[tuple[State, int], float] = {}
        self.children_cache: dict[State, list[tuple[Move, State]]] = {}
        self.profile = DIFFICULTIES["medium"]

    def choose_move(
        self,
        state: State,
        difficulty: str = "medium",
        cancel_event: Event | None = None,
    ) -> SearchResult:
        profile = DIFFICULTIES.get(difficulty, DIFFICULTIES["medium"])
        self.profile = profile
        started = monotonic()
        self.deadline = started + profile.time_limit
        self.cancel_event = cancel_event
        self.nodes = 0
        self.ordering.clear()
        self.history.clear()
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
        alpha = -inf
        beta = inf
        ranked: list[tuple[float, Move]] = []
        ordered = self._ordered_children(state, legal)
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
        self._check_interrupted()
        self.nodes += 1
        if depth <= 0 or state.winner or state.draw:
            return self.game.evaluate(state)

        cache_key = (state, depth)
        cached = self.cache.get(cache_key)
        if cached is not None:
            return cached

        children = self._ordered_children(state)
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
    ) -> list[tuple[Move, State]]:
        children = self.children_cache.get(state)
        if children is None:
            children = self.game.legal_children(state)
            if moves is not None:
                legal = set(moves)
                children = [item for item in children if item[0] in legal]
            self.children_cache[state] = children

        preferred = self.ordering.get(state)
        return sorted(
            children,
            key=lambda item: self._move_priority(state, item[0], item[1], preferred),
            reverse=True,
        )

    def _move_priority(self, state: State, move: Move, child: State, preferred: Move | None) -> float:
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
        return principal + terminal + self.history.get(move, 0) + adjacent_mirrors * 20

    def _branch_limit(self, ply: int) -> int | None:
        if not self.profile.branch_limits:
            return None
        index = min(max(0, ply - 1), len(self.profile.branch_limits) - 1)
        return self.profile.branch_limits[index]

    def _check_interrupted(self) -> None:
        if monotonic() >= self.deadline or (self.cancel_event and self.cancel_event.is_set()):
            raise SearchInterrupted
