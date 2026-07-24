import unittest
from concurrent.futures import Future
from threading import Event
from unittest.mock import Mock

from laser_war.ai import SearchResult
from laser_war.engine import Cell, Move
from laser_war.pygame_app import LaserWarGame, MoveAnimation
from laser_war.session import GameSession


class PygameAppTests(unittest.TestCase):
    def test_final_volley_is_retained_after_winning_animation(self):
        app = LaserWarGame.__new__(LaserWarGame)
        app.scene = "game"
        app.paused = False
        app.particles = []
        app.session = GameSession(mode="local")
        app.session.play(Move(4, 4, Cell.MIRROR_SLASH), "Bottom")
        app.session.play(Move(0, 0, Cell.MIRROR_SLASH), "Top")
        winning = app.session.play(Move(4, 5, Cell.MIRROR_SLASH), "Bottom")
        app.animation = MoveAnimation(winning, elapsed=1.15, damage_played=True)
        app.final_animation = None
        app.animation_speed = 1.0
        app.ai_future = None
        app.audio = Mock()

        app._update(0)

        self.assertEqual(app.session.state.winner, "bottom")
        self.assertIsNone(app.animation)
        self.assertIsNotNone(app.final_animation)
        self.assertEqual(app.final_animation.record, winning)

    def test_computer_game_redo_restores_exactly_one_move_per_click(self):
        app = LaserWarGame.__new__(LaserWarGame)
        app.session = GameSession(mode="computer")
        first = Move(4, 4, Cell.MIRROR_SLASH)
        second = Move(4, 3, Cell.MIRROR_BACKSLASH)
        app.session.play(first, "You")
        app.session.play(second, "Computer")
        final_state = app.session.state
        app.session.undo(2)

        app.ai_cancel = Event()
        app.ai_future = None
        app.ai_state = None
        app.audio = Mock()
        app.last_search = None
        app.legal_moves = set()
        app._autosave = Mock()
        app._start_ai = Mock()

        app._redo()

        self.assertEqual(len(app.session.history), 1)
        self.assertEqual(len(app.session.redo_stack), 1)
        self.assertEqual(app.session.history[-1].move, first)
        app._start_ai.assert_not_called()

        app._redo()

        self.assertEqual(len(app.session.history), 2)
        self.assertEqual(app.session.redo_stack, [])
        self.assertEqual(app.session.history[-1].move, second)
        self.assertEqual(app.session.state, final_state)
        app._start_ai.assert_not_called()

    def test_stale_ai_result_is_discarded_after_state_change(self):
        app = LaserWarGame.__new__(LaserWarGame)
        app.scene = "game"
        app.paused = False
        app.particles = []
        app.animation = None
        app.session = GameSession(mode="local")
        app.last_search = None

        stale_state = app.session.state
        stale_move = Move(4, 4, Cell.MIRROR_SLASH)
        app.session.play(stale_move, "Bottom")

        future: Future[SearchResult] = Future()
        future.set_result(SearchResult(stale_move, 0, 1, 1, 0))
        app.ai_future = future
        app.ai_state = stale_state

        app._update(0)

        self.assertIsNone(app.ai_future)
        self.assertIsNone(app.ai_state)
        self.assertEqual(len(app.session.history), 1)
        self.assertEqual(app.session.state.board[4][4], Cell.MIRROR_SLASH)


if __name__ == "__main__":
    unittest.main()
