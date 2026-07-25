import json
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory

from laser_war.progress import Progress


class ProgressTests(unittest.TestCase):
    def test_only_a_hard_computer_victory_unlocks_ultra(self):
        progress = Progress()

        self.assertFalse(progress.record_result(mode="local", difficulty="hard", winner="bottom"))
        self.assertFalse(progress.record_result(mode="computer", difficulty="medium", winner="bottom"))
        self.assertFalse(progress.record_result(mode="computer", difficulty="hard", winner="top"))
        self.assertTrue(progress.record_result(mode="computer", difficulty="hard", winner="bottom"))
        self.assertTrue(progress.ultra_unlocked)
        self.assertFalse(progress.record_result(mode="computer", difficulty="hard", winner="bottom"))

    def test_progress_round_trip_and_updates_never_relock_ultra(self):
        with TemporaryDirectory() as directory:
            path = Path(directory) / "progress.json"
            Progress(ultra_unlocked=True).save(path)
            self.assertTrue(Progress.load(path).ultra_unlocked)

            path.write_text(json.dumps({"version": 999, "ultra_unlocked": True}), encoding="utf-8")
            self.assertTrue(Progress.load(path).ultra_unlocked)

            path.write_text(json.dumps({"version": 999, "ultra_unlocked": False}), encoding="utf-8")
            self.assertFalse(Progress.load(path).ultra_unlocked)


if __name__ == "__main__":
    unittest.main()
