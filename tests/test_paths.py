import unittest
from pathlib import Path

from laser_war.paths import user_data_directory


class UserDataDirectoryTests(unittest.TestCase):
    def test_windows_uses_local_app_data(self):
        path = user_data_directory(
            platform="win32",
            environment={"LOCALAPPDATA": r"C:\Users\Paul\AppData\Local"},
            home=Path("/unused"),
        )

        self.assertEqual(path, Path(r"C:\Users\Paul\AppData\Local") / "Laser War")

    def test_windows_has_a_home_directory_fallback(self):
        path = user_data_directory(platform="win32", environment={}, home=Path("/Users/Paul"))

        self.assertEqual(path, Path("/Users/Paul/AppData/Local/Laser War"))

    def test_macos_keeps_the_existing_location(self):
        path = user_data_directory(platform="darwin", environment={}, home=Path("/Users/Paul"))

        self.assertEqual(path, Path("/Users/Paul/Library/Application Support/Laser War"))

    def test_linux_respects_xdg_data_home(self):
        path = user_data_directory(
            platform="linux",
            environment={"XDG_DATA_HOME": "/home/paul/custom-data"},
            home=Path("/home/paul"),
        )

        self.assertEqual(path, Path("/home/paul/custom-data/laser-war"))


if __name__ == "__main__":
    unittest.main()
