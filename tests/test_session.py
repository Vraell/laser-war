import json
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory

from laser_war.engine import Cell, Move, State
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
            self.assertEqual(loaded.match_id, session.match_id)
            self.assertEqual(loaded.started_at, session.started_at)
            self.assertEqual(loaded.events, session.events)
            self.assertEqual(loaded.history[0].summary, session.history[0].summary)

    def test_summary_can_be_rendered_in_french_without_changing_saved_actor(self):
        session = GameSession(mode="computer")
        record = session.play(Move(4, 4, Cell.MIRROR_SLASH), "you")

        self.assertIn("Vous", record.summary_for("fr"))
        self.assertIn("L5C5", record.summary_for("fr"))
        self.assertEqual(record.actor, "you")

    def test_match_log_updates_one_file_and_preserves_every_move(self):
        session = GameSession(mode="local")
        session.play(Move(4, 4, Cell.MIRROR_SLASH), "Bottom")

        with TemporaryDirectory() as directory:
            log_directory = Path(directory) / "matches"
            path = session.save_match_log(log_directory)
            self.assertIsNotNone(path)

            session.play(Move(4, 3, Cell.MIRROR_BACKSLASH), "Top")
            updated_path = session.save_match_log(log_directory, "abandoned")
            self.assertEqual(updated_path, path)

            files = list(log_directory.glob("*.json"))
            self.assertEqual(files, [path])
            data = json.loads(path.read_text(encoding="utf-8"))
            self.assertEqual(data["move_count"], 2)
            self.assertEqual(data["status"], "abandoned")
            self.assertEqual([move["number"] for move in data["moves"]], [1, 2])
            self.assertEqual([event["type"] for event in data["events"]], ["move", "move"])

    def test_failed_redo_keeps_the_record_available(self):
        session = GameSession(mode="local")
        move = Move(4, 4, Cell.MIRROR_SLASH)
        session.play(move, "Bottom")
        session.undo()

        board = [list(row) for row in session.state.board]
        board[move.row][move.col] = Cell.MIRROR_BACKSLASH
        session.state = State(tuple(tuple(row) for row in board), turn=session.state.turn)

        with self.assertRaisesRegex(ValueError, "not empty"):
            session.redo()

        self.assertEqual(len(session.redo_stack), 1)
        self.assertEqual(session.redo_stack[-1].move, move)

    def test_unknown_save_version_is_rejected(self):
        with TemporaryDirectory() as directory:
            path = Path(directory) / "save.json"
            path.write_text(json.dumps({"version": 999}), encoding="utf-8")

            with self.assertRaisesRegex(ValueError, "unsupported version"):
                GameSession.load(path)

    def test_save_from_previous_rules_version_is_rejected(self):
        with TemporaryDirectory() as directory:
            path = Path(directory) / "save.json"
            path.write_text(json.dumps({"version": 1, "moves": []}), encoding="utf-8")

            with self.assertRaisesRegex(ValueError, "unsupported version"):
                GameSession.load(path)


if __name__ == "__main__":
    unittest.main()
