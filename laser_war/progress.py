from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path

from .storage import write_json_atomic

PROGRESS_VERSION = 1


@dataclass
class Progress:
    ultra_unlocked: bool = False

    @classmethod
    def load(cls, path: Path) -> Progress:
        """Load validated unlock progress or return a locked default."""
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError, TypeError):
            return cls()
        if data.get("version") != PROGRESS_VERSION:
            return cls()
        return cls(ultra_unlocked=bool(data.get("ultra_unlocked")))

    def save(self, path: Path) -> None:
        """Persist unlock progress atomically."""
        write_json_atomic(
            path,
            {
                "version": PROGRESS_VERSION,
                "ultra_unlocked": self.ultra_unlocked,
            },
        )

    def record_result(self, *, mode: str, difficulty: str, winner: str | None) -> bool:
        """Unlock Ultra after the first qualifying Hard-mode victory."""
        if self.ultra_unlocked or mode != "computer" or difficulty != "hard" or winner != "bottom":
            return False
        self.ultra_unlocked = True
        return True
