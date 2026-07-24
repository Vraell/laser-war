# Laser War

A polished desktop reconstruction of the mirror-and-laser strategy game.

## Play

Requires Python 3.10 or newer.

```bash
python3.11 -m pip install -e .
python3.11 -m laser_war
```

The game includes:

- computer opponents with Easy, Medium, and Hard search profiles;
- local two-player mode;
- scalable 60 FPS rendering;
- animated simultaneous lasers, impacts, particles, and synthesized sound;
- legal-move highlighting and forbidden-square markings;
- pause, undo, redo, restart, autosave, and continue;
- a validated match history with damage events.

## Controls

- `Q` selects the `/` mirror.
- `E` selects the `\` mirror.
- `U` undoes the latest turn.
- `R` restarts the match.
- `Escape` pauses.

## Development

Run the tests:

```bash
python3.11 -m unittest
```

Install development tools and run quality checks:

```bash
python3.11 -m pip install -e ".[dev]"
ruff check .
coverage run -m unittest
coverage report
```

The rules engine is independent of Pygame. `session.py` owns reversible match history and saves, `ai.py` owns
time-bounded search, and `pygame_app.py` owns presentation and input.

See `docs/LASER_WAR_RULES.md` for the reconstructed rules.

## Optional macOS App

The Python command remains the primary development workflow. To produce a normal application bundle:

```bash
./scripts/build_macos.sh
```

The bundle is written to `dist/Laser War.app`.
