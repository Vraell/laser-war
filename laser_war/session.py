from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from .engine import Cell, Game, Move, MoveOutcome, State

SAVE_VERSION = 1


@dataclass(frozen=True)
class TurnRecord:
    number: int
    actor: str
    before: State
    move: Move
    outcome: MoveOutcome

    @property
    def summary(self) -> str:
        effects: list[str] = []
        if self.outcome.destroyed:
            positions = ", ".join(f"R{row + 1}C{col + 1}" for row, col in self.outcome.destroyed)
            effects.append(f"shield destroyed at {positions}")
        if self.outcome.hit_kings:
            kings = " and ".join(sorted(self.outcome.hit_kings))
            effects.append(f"{kings} king hit")
        detail = ", ".join(effects) if effects else "no damage"
        return (
            f"{self.number}. {self.actor}: {self.move.mirror.value} "
            f"at R{self.move.row + 1}C{self.move.col + 1} - {detail}"
        )


class GameSession:
    def __init__(
        self,
        game: Game | None = None,
        *,
        mode: str = "computer",
        difficulty: str = "medium",
    ):
        self.game = game or Game()
        self.mode = mode
        self.difficulty = difficulty
        self.state = self.game.initial_state()
        self.history: list[TurnRecord] = []
        self.redo_stack: list[TurnRecord] = []

    def new_game(self, *, mode: str | None = None, difficulty: str | None = None) -> None:
        if mode is not None:
            self.mode = mode
        if difficulty is not None:
            self.difficulty = difficulty
        self.state = self.game.initial_state()
        self.history.clear()
        self.redo_stack.clear()

    def play(self, move: Move, actor: str) -> TurnRecord:
        before = self.state
        outcome = self.game.resolve_move(before, move)
        record = TurnRecord(len(self.history) + 1, actor, before, move, outcome)
        self.history.append(record)
        self.redo_stack.clear()
        self.state = outcome.state
        return record

    def undo(self, plies: int = 1) -> list[TurnRecord]:
        undone: list[TurnRecord] = []
        for _ in range(min(plies, len(self.history))):
            record = self.history.pop()
            self.redo_stack.append(record)
            self.state = record.before
            undone.append(record)
        return undone

    def redo(self, plies: int = 1) -> list[TurnRecord]:
        restored: list[TurnRecord] = []
        for _ in range(min(plies, len(self.redo_stack))):
            old_record = self.redo_stack[-1]
            before = self.state
            outcome = self.game.resolve_move(before, old_record.move)
            self.redo_stack.pop()
            record = TurnRecord(len(self.history) + 1, old_record.actor, before, old_record.move, outcome)
            self.history.append(record)
            self.state = outcome.state
            restored.append(record)
        return restored

    def to_dict(self) -> dict[str, Any]:
        return {
            "version": SAVE_VERSION,
            "mode": self.mode,
            "difficulty": self.difficulty,
            "moves": [
                {
                    "actor": record.actor,
                    "row": record.move.row,
                    "col": record.move.col,
                    "mirror": record.move.mirror.value,
                }
                for record in self.history
            ],
        }

    def save(self, path: Path) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        temporary = path.with_suffix(path.suffix + ".tmp")
        temporary.write_text(json.dumps(self.to_dict(), indent=2) + "\n", encoding="utf-8")
        temporary.replace(path)

    @classmethod
    def load(cls, path: Path, game: Game | None = None) -> GameSession:
        data = json.loads(path.read_text(encoding="utf-8"))
        if data.get("version") != SAVE_VERSION:
            raise ValueError("This save was created by an unsupported version of Laser War.")
        session = cls(game, mode=str(data["mode"]), difficulty=str(data["difficulty"]))
        for item in data.get("moves", []):
            move = Move(int(item["row"]), int(item["col"]), Cell(str(item["mirror"])))
            session.play(move, str(item["actor"]))
        return session
