# Laser War

A polished desktop reconstruction of the mirror-and-laser strategy game.

## Play Online

Play at [vraell.github.io/laser-war](https://vraell.github.io/laser-war/). No installation or Python runtime
is required. Every move is saved immediately in that browser so an interrupted match can continue. Use
**Copy** beside the in-game match log to place the titled, dated, participant-labelled log on the clipboard.

## Play

Requires Python 3.10 or newer.

```bash
python3.11 -m pip install -e .
python3.11 -m laser_war
```

The game includes:

- computer opponents with Easy, Medium, Hard, and unlockable Ultra search profiles;
- local two-player mode;
- a persistent English/French interface;
- scalable 60 FPS rendering;
- animated simultaneous lasers, impacts, particles, and synthesized sound;
- legal-move highlighting, forbidden-square markings, and reason-specific move feedback;
- a clearly retained final laser volley after a win or draw;
- a shared-route anti-fortress rule that keeps both kings and both lasers viable;
- pause, undo, redo, restart, autosave, and continue;
- a validated recent-match history with damage events;
- a scrollable current-match log with one-click clipboard copying.

Ultra unlocks after the player defeats the Hard computer. Progress is stored locally on each device.
Ultra combines time-bounded iterative-deepening alpha-beta search with tactical king-threat stabilization, mate-distance
scoring, shield and laser-route evaluation, and principal-variation, history, and killer-move ordering.
An earned Ultra unlock is preserved when the progress-data format or game version changes.

The interface uses the bundled Inter typeface under the SIL Open Font License.

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

Build the native browser version locally:

```bash
./scripts/build_web.sh
```

The static site is written to `build/web`. It is a small HTML, CSS, and JavaScript client that implements the
same board, laser, damage, king-safety, and anti-fortress rules as the Python engine without a WebAssembly
startup delay.

The rules engine is independent of Pygame. `session.py` owns reversible match history and saves, `progress.py`
owns monotonic unlock progression, `ai.py` owns time-bounded search, and `pygame_app.py` owns presentation and input.
The browser runs computer searches in a Web Worker so deeper searches do not block touch or rendering.

The Python client updates one JSON record per match after every move. On macOS these records are stored in
`~/Library/Application Support/Laser War/matches/`; equivalent per-user application-data directories are used
on Windows and Linux.

See `docs/LASER_WAR_RULES.md` for the reconstructed rules.

## Windows

Download the latest installer from the GitHub Releases page. It installs for the current user, requires no
Python installation or administrator access, and adds Start menu and optional desktop shortcuts.

The portable ZIP contains the same game without an installer: extract the full folder and run `Laser War.exe`.

To build both packages on Windows:

```powershell
./scripts/build_windows.ps1
```

This requires Python 3.11 and Inno Setup 6. Tagged GitHub releases build and publish both packages automatically.

## Optional macOS App

The Python command remains the primary development workflow. To produce a normal application bundle:

```bash
./scripts/build_macos.sh
```

The bundle is written to `dist/Laser War.app`.
