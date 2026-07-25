from __future__ import annotations

import os
import sys
from collections.abc import Mapping
from pathlib import Path


def user_data_directory(
    *,
    platform: str | None = None,
    environment: Mapping[str, str] | None = None,
    home: Path | None = None,
) -> Path:
    platform = platform or sys.platform
    environment = environment or os.environ
    home = home or Path.home()

    if platform == "win32":
        root = Path(environment.get("LOCALAPPDATA", home / "AppData" / "Local"))
        return root / "Laser War"
    if platform == "darwin":
        return home / "Library" / "Application Support" / "Laser War"

    root = Path(environment.get("XDG_DATA_HOME", home / ".local" / "share"))
    return root / "laser-war"


SAVE_PATH = user_data_directory() / "autosave.json"
PROGRESS_PATH = user_data_directory() / "progress.json"
PREFERENCES_PATH = user_data_directory() / "preferences.json"
MATCH_LOG_DIRECTORY = user_data_directory() / "matches"
