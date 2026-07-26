# Laser War

A browser-based mirror-and-laser strategy game.

## Play

Play at [vraell.github.io/laser-war](https://vraell.github.io/laser-war/). The game requires no installation
and works on desktop and mobile browsers.

Features include:

- Easy, Medium, Hard, and unlockable Ultra computer opponents;
- local two-player play;
- English and French interfaces;
- animated simultaneous lasers, impacts, sound, and a retained final volley;
- legal-move feedback and forbidden-square markings;
- a shared-route anti-fortress rule that keeps both kings and both lasers viable;
- automatic in-browser match saves and a clipboard-ready match log.

Ultra unlocks after defeating Hard. Progress and the current match are stored locally in the browser and
survive game updates.

Ultra uses iterative deepening with threat-aware root coverage and wider reply sampling in developed positions.
Its Web Worker and search tables persist for the match, allowing later turns to reuse explored continuations
instead of restarting from an empty tree. Every move that can alter the live laser volley is searched alongside
the strongest quiet candidates, so tactical defenses cannot disappear behind a positional shortlist. Quiet turns
retain short think targets, while unstable score swings and developed 23-mirror positions unlock the remaining
six-second tactical budget.

## Development

The application is static HTML, CSS, and JavaScript. No package installation or compilation is required.

Run all tests:

```bash
node --test web/*.test.mjs
```

Compare every difficulty against the previous AI revision with paired, color-swapped games:

```bash
node scripts/elo_benchmark.mjs --pairs 12 --baseline-ref HEAD
```

The arena reports win/draw/loss results, estimated Elo change with a 95% interval, illegal moves, and average
search time. The Pages workflow runs a bounded arena before every deployment and rejects statistically supported
strength regressions. Reported tactical failures should also become position fixtures in `web/fixtures/` with a
targeted assertion in `web/ultra.test.mjs`; Elo testing and position regressions cover different failure modes.
Use `--difficulties ultra`, `--opening-plies 4`, and `--seed-offset N` for faster focused runs and independent
opening samples. `--ultra-time 1000` raises the arena's default compressed 300 ms Ultra budget for a more
production-like strength check.

Analyze a copied English or French match log with a wider offline Ultra search:

```bash
node scripts/analyze_match.mjs path/to/match-log.txt --jobs 4
```

The analyzer validates and replays the match, compares every played move with its preferred continuation, then
deepens the largest candidate mistakes. Near the finish it also performs tactical proof search: attacking moves
are restricted to placements that alter a live laser, while every legal defense is covered. Proven wins override
heuristic evaluations in the report. It writes an interactive evaluation chart, board explorer, and
machine-readable JSON to `artifacts/`. Use `--depth`, `--refine`, `--refine-depth`, `--tactical-plies`, and
`--tactical-window` to adjust the analysis.

Build and validate the GitHub Pages artifact:

```bash
./scripts/build_web.sh
node scripts/check_web_build.mjs
```

The staged site is written to `build/web`. Ultra runs in a Web Worker so its iterative-deepening search does
not block input or rendering.

See [docs/LASER_WAR_RULES.md](docs/LASER_WAR_RULES.md) for the complete rules.
