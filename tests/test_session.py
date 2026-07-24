import json
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory

from laser_war.engine import Cell, Move
from laser_war.session import GameSession


class SessionTests(unittest.TestCase):
    def test_undo_and_redo_restore_exact_states(self):
        session = GameSession(mode="local")
        initial = session.state
        first = session.play(Move(4, 4, Cell.MIRROR_SLASH), "Bottom")
        second = session.play(Move(4, 3, Cell.MIRROR_BACKSLASH), "Top")
        final = session.state

        session.undo(2)
        self.assertEqual(session.state, initial)
        self.assertEqual(len(session.redo_stack), 2)

        restored = session.redo(2)
        self.assertEqual(session.state, final)
        self.assertEqual([record.move for record in restored], [first.move, second.move])

    def test_save_load_replays_validated_history(self):
        session = GameSession(mode="computer", difficulty="hard")
        session.play(Move(4, 4, Cell.MIRROR_SLASH), "You")

        with TemporaryDirectory() as directory:
            path = Path(directory) / "save.json"
            session.save(path)
            loaded = GameSession.load(path)

            self.assertEqual(loaded.state, session.state)
            self.assertEqual(loaded.mode, "computer")
            self.assertEqual(loaded.difficulty, "hard")
            self.assertEqual(loaded.history[0].summary, session.history[0].summary)

    def test_unknown_save_version_is_rejected(self):
        with TemporaryDirectory() as directory:
            path = Path(directory) / "save.json"
            path.write_text(json.dumps({"version": 999}), encoding="utf-8")

            with self.assertRaisesRegex(ValueError, "unsupported version"):
                GameSession.load(path)


if __name__ == "__main__":
    unittest.main()
