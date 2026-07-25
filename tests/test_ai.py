import unittest
from dataclasses import replace
from threading import Event

from laser_war.ai import DIFFICULTIES, ComputerAI
from laser_war.engine import Cell, Game, Move


class AITests(unittest.TestCase):
    def test_easy_ai_returns_a_legal_move_with_search_metadata(self):
        game = Game()
        state = game.initial_state(turn="top")
        ai = ComputerAI(game, seed=3)

        result = ai.choose_move(state, "easy")

        self.assertIn(result.move, game.legal_moves(state))
        self.assertGreaterEqual(result.depth, 1)
        self.assertGreater(result.nodes, 0)
        self.assertLess(result.elapsed, 1.0)

    def test_cancelled_search_still_returns_legal_fallback(self):
        game = Game()
        state = game.initial_state(turn="top")
        cancelled = Event()
        cancelled.set()

        result = ComputerAI(game).choose_move(state, "hard", cancelled)

        self.assertIn(result.move, game.legal_moves(state))
        self.assertEqual(result.depth, 0)

    def test_difficulty_profiles_increase_search_budget(self):
        self.assertLess(DIFFICULTIES["easy"].time_limit, DIFFICULTIES["medium"].time_limit)
        self.assertLess(DIFFICULTIES["medium"].time_limit, DIFFICULTIES["hard"].time_limit)
        self.assertLess(DIFFICULTIES["hard"].time_limit, DIFFICULTIES["ultra"].time_limit)
        self.assertLess(DIFFICULTIES["easy"].max_depth, DIFFICULTIES["hard"].max_depth)
        self.assertGreaterEqual(DIFFICULTIES["ultra"].max_depth, 4)

    def test_easy_ai_answers_the_center_gambit(self):
        game = Game()
        state = game.resolve_move(
            game.initial_state(),
            Move(4, 4, Cell.MIRROR_SLASH),
            check_no_legal_moves=False,
        ).state

        response = ComputerAI(game, seed=7).choose_move(state, "easy")
        defended = game.resolve_move(state, response.move, check_no_legal_moves=False).state
        opponent_can_win_immediately = any(
            game.resolve_move(defended, move, check_no_legal_moves=False).state.winner == "bottom"
            for move in game.legal_moves(defended)
        )

        self.assertFalse(opponent_can_win_immediately)

    def test_ultra_sees_past_the_known_hard_horizon_blunder(self):
        game = Game()
        state = game.initial_state()
        setup = [
            (4, 1, "/"),
            (8, 1, "\\"),
            (4, 7, "\\"),
            (0, 0, "/"),
            (1, 7, "\\"),
            (0, 1, "\\"),
            (1, 2, "\\"),
            (0, 2, "\\"),
            (0, 6, "\\"),
            (1, 6, "/"),
            (2, 7, "\\"),
            (2, 5, "/"),
            (3, 7, "/"),
            (7, 0, "\\"),
            (5, 0, "/"),
            (2, 2, "/"),
            (3, 4, "/"),
            (3, 2, "\\"),
            (2, 3, "\\"),
            (0, 7, "/"),
            (4, 3, "/"),
        ]
        for row, col, mirror in setup:
            state = game.resolve_move(state, Move(row, col, Cell(mirror))).state

        profile = DIFFICULTIES["ultra"]
        DIFFICULTIES["ultra"] = replace(profile, time_limit=30.0)
        try:
            result = ComputerAI(game).choose_move(state, "ultra")
        finally:
            DIFFICULTIES["ultra"] = profile

        self.assertGreaterEqual(result.depth, 4)
        self.assertIn(result.move, game.legal_moves(state))
        self.assertNotEqual(result.move, Move(0, 8, Cell.MIRROR_SLASH))


if __name__ == "__main__":
    unittest.main()
