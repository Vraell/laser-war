from __future__ import annotations

import json
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Any
from uuid import uuid4

from .engine import Cell, Game, Move, MoveOutcome, State
from .i18n import translate
from .storage import write_json_atomic

SAVE_VERSION = 2


@dataclass(frozen=True)
class TurnRecord:
    number: int
    actor: str
    before: State
    move: Move
    outcome: MoveOutcome

    @property
    def summary(self) -> str:
        return self.summary_for("en")

    def summary_for(self, language: str) -> str:
        effects: list[str] = []
        if self.outcome.destroyed:
            positions = ", ".join(
                translate(language, "position", row=row + 1, col=col + 1) for row, col in self.outcome.destroyed
            )
            effects.append(translate(language, "shield_destroyed", positions=positions))
        if self.outcome.hit_kings:
            if len(self.outcome.hit_kings) == 2:
                effects.append(translate(language, "both_kings_hit"))
            else:
                king = next(iter(self.outcome.hit_kings))
                effects.append(translate(language, "single_king_hit", king=translate(language, f"{king}_king")))
        detail = ", ".join(effects) if effects else translate(language, "no_damage")
        position = translate(language, "position", row=self.move.row + 1, col=self.move.col + 1)
        return translate(
            language,
            "record",
            number=self.number,
            actor=self._actor_label(language),
            mirror=self.move.mirror.value,
            position=position,
            detail=detail,
        )

    def _actor_label(self, language: str) -> str:
        actor = self.actor.lower()
        if actor in {"you", "vous"}:
            return translate(language, "you")
        if actor in {"computer", "ordinateur"}:
            return translate(language, "computer")
        if actor in {"top", "haut"}:
            return translate(language, "top_player")
        if actor in {"bottom", "bas"}:
            return translate(language, "bottom_player")
        return self.actor


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
        self.match_id = str(uuid4())
        self.started_at = self._now()
        self.events: list[dict[str, Any]] = []

    def new_game(self, *, mode: str | None = None, difficulty: str | None = None) -> None:
        if mode is not None:
            self.mode = mode
        if difficulty is not None:
            self.difficulty = difficulty
        self.state = self.game.initial_state()
        self.history.clear()
        self.redo_stack.clear()
        self.match_id = str(uuid4())
        self.started_at = self._now()
        self.events.clear()

    def play(self, move: Move, actor: str) -> TurnRecord:
        before = self.state
        outcome = self.game.resolve_move(before, move)
        record = TurnRecord(len(self.history) + 1, actor, before, move, outcome)
        self.history.append(record)
        self.redo_stack.clear()
        self.state = outcome.state
        self.events.append(self._event_for_record(record))
        return record

    def undo(self, plies: int = 1) -> list[TurnRecord]:
        undone: list[TurnRecord] = []
        for _ in range(min(plies, len(self.history))):
            record = self.history.pop()
            self.redo_stack.append(record)
            self.state = record.before
            undone.append(record)
            self.events.append({"type": "undo", "at": self._now(), "number": record.number})
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
            self.events.append(self._event_for_record(record, event_type="redo"))
        return restored

    def to_dict(self) -> dict[str, Any]:
        return {
            "version": SAVE_VERSION,
            "match_id": self.match_id,
            "started_at": self.started_at,
            "mode": self.mode,
            "difficulty": self.difficulty,
            "events": self.events,
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
        write_json_atomic(path, self.to_dict())

    def to_match_dict(self, status: str = "active") -> dict[str, Any]:
        completed = bool(self.state.winner or self.state.draw)
        resolved_status = "completed" if completed else status
        timestamp = self._now()
        return {
            "version": SAVE_VERSION,
            "id": self.match_id,
            "started_at": self.started_at,
            "updated_at": timestamp,
            "ended_at": None if resolved_status == "active" else timestamp,
            "status": resolved_status,
            "mode": self.mode,
            "difficulty": self.difficulty,
            "winner": self.state.winner,
            "draw": self.state.draw,
            "turn": self.state.turn,
            "final_board": ["".join(cell.value for cell in row) for row in self.state.board],
            "move_count": len(self.history),
            "moves": [
                {
                    "number": record.number,
                    "actor": record.actor,
                    "row": record.move.row,
                    "col": record.move.col,
                    "mirror": record.move.mirror.value,
                    "destroyed": [list(position) for position in record.outcome.destroyed],
                    "hit_kings": sorted(record.outcome.hit_kings),
                }
                for record in self.history
            ],
            "events": self.events,
        }

    def save_match_log(self, directory: Path, status: str = "active") -> Path | None:
        if not self.history:
            return None
        path = directory / f"{self.started_at[:10]}_{self.match_id}.json"
        write_json_atomic(path, self.to_match_dict(status))
        return path

    @classmethod
    def load(cls, path: Path, game: Game | None = None) -> GameSession:
        data = json.loads(path.read_text(encoding="utf-8"))
        if data.get("version") != SAVE_VERSION:
            raise ValueError("This save was created by an unsupported version of Laser War.")
        session = cls(game, mode=str(data["mode"]), difficulty=str(data["difficulty"]))
        session.match_id = str(data.get("match_id", session.match_id))
        session.started_at = str(data.get("started_at", session.started_at))
        for item in data.get("moves", []):
            move = Move(int(item["row"]), int(item["col"]), Cell(str(item["mirror"])))
            session.play(move, str(item["actor"]))
        if isinstance(data.get("events"), list):
            session.events = list(data["events"])
        return session

    @staticmethod
    def _now() -> str:
        return datetime.now(UTC).isoformat()

    def _event_for_record(self, record: TurnRecord, event_type: str = "move") -> dict[str, Any]:
        return {
            "type": event_type,
            "at": self._now(),
            "number": record.number,
            "actor": record.actor,
            "row": record.move.row,
            "col": record.move.col,
            "mirror": record.move.mirror.value,
            "destroyed": [list(position) for position in record.outcome.destroyed],
            "hit_kings": sorted(record.outcome.hit_kings),
        }
