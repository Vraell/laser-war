import json
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory

from laser_war.i18n import translate
from laser_war.preferences import Preferences


class PreferencesTests(unittest.TestCase):
    def test_language_preference_round_trip(self):
        with TemporaryDirectory() as directory:
            path = Path(directory) / "preferences.json"
            preferences = Preferences()
            preferences.set_language("fr")
            preferences.save(path)

            self.assertEqual(Preferences.load(path).language, "fr")

    def test_invalid_language_and_version_fall_back_to_english(self):
        preferences = Preferences()
        preferences.set_language("de")
        self.assertEqual(preferences.language, "en")

        with TemporaryDirectory() as directory:
            path = Path(directory) / "preferences.json"
            path.write_text(json.dumps({"version": 999, "language": "fr"}), encoding="utf-8")
            self.assertEqual(Preferences.load(path).language, "en")

    def test_french_translation_interpolates_values(self):
        self.assertEqual(
            translate("fr", "result_detail", difficulty="DIFFICILE", count="17 COUPS"),
            "DIFFICILE  |  17 COUPS",
        )
        self.assertEqual(
            translate("fr", "side_wins", side=translate("fr", "bottom")),
            "Le joueur du bas gagne",
        )
        self.assertEqual(
            translate("fr", "side_to_move", side=translate("fr", "top")),
            "Au tour du joueur du haut",
        )


if __name__ == "__main__":
    unittest.main()
