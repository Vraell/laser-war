from __future__ import annotations

import random
from dataclasses import dataclass
from math import inf
from threading import Event
from time import monotonic

from .engine import Game, Move, State


@dataclass(frozen=True)
class DifficultyProfile:
    label: str
    time_limit: float
    max_depth: int
    candidate_spread: int = 1


DIFFICULTIES = {
    "easy": DifficultyProfile("Easy", 0.20, 1, 5),
    "medium": DifficultyProfile("Medium", 1.25, 3, 1),
    "hard": DifficultyProfile("Hard", 3.50, 5, 1),
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
        self.cache: dict[tuple[State, int], float] = {}

    def choose_move(
        self,
        state: State,
        difficulty: str = "medium",
        cancel_event: Event | None = None,
    ) -> SearchResult:
        profile = DIFFICULTIES.get(difficulty, DIFFICULTIES["medium"])
        started = monotonic()
        self.deadline = started + profile.time_limit
        self.cancel_event = cancel_event
        self.nodes = 0
        self.ordering.clear()
        self.cache.clear()

        legal = self.game.legal_moves(state)
        if not legal:
            return SearchResult(None, self.game.evaluate(state), 0, self.nodes, monotonic() - started)

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
        ordered = self._ordered_moves(state, legal)

        for move in ordered:
            self._check_interrupted()
            child = self.game.resolve_move(state, move, check_no_legal_moves=False).state
            score = -self._negamax(child, depth - 1, -beta, -alpha)
            ranked.append((score, move))
            alpha = max(alpha, score)

        ranked.sort(key=lambda item: item[0], reverse=True)
        score, move = ranked[0]
        return score, move, ranked

    def _negamax(self, state: State, depth: int, alpha: float, beta: float) -> float:
        self._check_interrupted()
        self.nodes += 1
        if depth <= 0 or state.winner or state.draw:
            return self.game.evaluate(state)

        cache_key = (state, depth)
        cached = self.cache.get(cache_key)
        if cached is not None:
            return cached

        legal = self.game.legal_moves(state)
        if not legal:
            return 0

        value = -inf
        cutoff = False
        best_move: Move | None = None
        for move in self._ordered_moves(state, legal):
            child = self.game.resolve_move(state, move, check_no_legal_moves=False).state
            score = -self._negamax(child, depth - 1, -beta, -alpha)
            if score > value:
                value = score
                best_move = move
            alpha = max(alpha, value)
            if alpha >= beta:
                cutoff = True
                break

        if best_move is not None:
            self.ordering[state] = best_move
        if not cutoff:
            self.cache[cache_key] = value
        return value

    def _ordered_moves(self, state: State, moves: list[Move]) -> list[Move]:
        preferred = self.ordering.get(state)
        if preferred is None or preferred not in moves:
            return moves
        return [preferred, *(move for move in moves if move != preferred)]

    def _check_interrupted(self) -> None:
        if monotonic() >= self.deadline or (self.cancel_event and self.cancel_event.is_set()):
            raise SearchInterrupted
