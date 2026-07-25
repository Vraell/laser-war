from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path

from .storage import write_json_atomic

PREFERENCES_VERSION = 1


@dataclass
class Preferences:
    language: str = "en"

    @classmethod
    def load(cls, path: Path) -> Preferences:
        """Load validated interface preferences or return defaults."""
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError, TypeError):
            return cls()
        if data.get("version") != PREFERENCES_VERSION:
            return cls()
        return cls(language="fr" if data.get("language") == "fr" else "en")

    def save(self, path: Path) -> None:
        """Persist interface preferences atomically."""
        write_json_atomic(
            path,
            {
                "version": PREFERENCES_VERSION,
                "language": self.language,
            },
        )

    def set_language(self, language: str) -> None:
        self.language = "fr" if language == "fr" else "en"
