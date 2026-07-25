import json
import unittest
from dataclasses import replace
from pathlib import Path
from threading import Event

from laser_war.ai import DIFFICULTIES, MATE_SCORE, ComputerAI
from laser_war.engine import Cell, Game, Move

FIXTURES = Path(__file__).parent / "fixtures"


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
        self.assertGreaterEqual(DIFFICULTIES["ultra"].max_depth, 8)

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
            state = game.resolve_move(
                state,
                Move(row, col, Cell(mirror)),
                check_no_legal_moves=False,
                check_joint_paths=False,
            ).state

        profile = DIFFICULTIES["ultra"]
        DIFFICULTIES["ultra"] = replace(profile, label="Ultra Test", time_limit=30.0, max_depth=4)
        ai = ComputerAI(game)
        try:
            result = ai.choose_move(state, "ultra")
        finally:
            DIFFICULTIES["ultra"] = profile

        self.assertGreaterEqual(result.depth, 4)
        self.assertIn(result.move, game.legal_moves(state))
        self.assertNotEqual(result.move, Move(0, 8, Cell.MIRROR_SLASH))
        self.assertTrue(ai.killers)

    def test_ultra_stabilizes_exposed_king_horizon_as_forced_loss(self):
        game = Game()
        state = game.initial_state()
        fixture = json.loads((FIXTURES / "forced_loss_40_move_log.json").read_text())
        for row, col, mirror in fixture["moves"][:-1]:
            move = Move(row - 1, col - 1, Cell(mirror))
            state = game.resolve_move(state, move).state

        ai = ComputerAI(game)
        score = ai._stabilized_evaluation(state, ply=4)

        self.assertEqual(score, -MATE_SCORE + 5)
        self.assertGreater(ai.nodes, 0)

    def test_ultra_uses_shorter_targets_until_the_late_game(self):
        game = Game()
        ai = ComputerAI(game)
        ai.profile = DIFFICULTIES["ultra"]

        early_deadline, early_is_late = ai._soft_deadline(game.initial_state(), 0)

        state = game.initial_state()
        fixture = json.loads((FIXTURES / "old_ultra_loss_38_move_log.json").read_text())
        for row, col, mirror in fixture["moves"][:31]:
            state = game.resolve_move(state, Move(row - 1, col - 1, Cell(mirror))).state
        late_deadline, late_is_late = ai._soft_deadline(state, 0)

        self.assertEqual(early_deadline, 2.25)
        self.assertFalse(early_is_late)
        self.assertEqual(late_deadline, 6.0)
        self.assertTrue(late_is_late)


if __name__ == "__main__":
    unittest.main()
