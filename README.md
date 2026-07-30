# Laser War

A browser-based mirror-and-laser strategy game.

## Play

Play at [vraell.github.io/laser-war](https://vraell.github.io/laser-war/). The game requires no installation
and works on desktop and mobile browsers.

Features include:

- Easy, Medium, Hard, and unlockable Ultra computer opponents;
- selectable Red/first or Blue/second play with a fixed player-facing board perspective;
- local two-player play;
- English and French interfaces;
- animated simultaneous lasers, impacts, sound, and a retained final volley;
- legal-move feedback and forbidden-square markings;
- a shared-route anti-fortress rule that keeps both kings and both lasers viable;
- automatic in-browser match saves and a clipboard-ready match log.

Ultra unlocks after defeating Hard. Progress and the current match are stored locally in the browser and
survive game updates.

Ultra combines iterative deepening, alpha-beta principal-variation search, transposition bounds, history and
killer ordering, and a selective tactical extension. It checks every legal mate-in-one before pruning the root,
and every move that can alter the current laser volley is searched alongside the strongest quiet candidates, so
tactical defenses do not disappear behind a positional shortlist. Quiet turns target four seconds; developed or
unstable positions can progressively use six, eight, or at most ten seconds. Search runs in a Web Worker and
keeps move-ordering knowledge across turns without freezing the interface. A separate proof-number-style solver
certifies short forcing lines in offline analysis and tactical regression tests; an always-on production prepass
was removed after ablation testing showed that ordinary search used the same compute more effectively.
During quiet openings, Ultra varies its play only among moves tied at the deepest completed root score. This
provides different games without knowingly selecting a lower-evaluated move.

The static evaluation is intentionally small and auditable. It scores remaining king cover, shield shape,
independent laser reachability, exact per-laser route costs, and current king exposure. A simultaneous exposure
is neutral because both lasers fire together. Extra fixed-target and broad root heuristics were tested and
rejected when paired games showed that they duplicated route pressure or reduced playing strength.

## Release History

See [CHANGELOG.md](CHANGELOG.md) for semi-detailed patch notes from the first playable build through the current
release. Early entries are reconstructed from Git history, and future work is recorded under `Unreleased` before
shipping.

## Development

The application is static HTML, CSS, and JavaScript. No package installation or compilation is required.

Run all tests and tactical regressions:

```bash
node --test web/*.test.mjs scripts/arena_stats.test.mjs
node scripts/tactical_benchmark.mjs
```

Check fixed-depth search throughput against a Git revision:

```bash
node scripts/search_benchmark.mjs HEAD --gate=nonregression
```

Compare every difficulty against a previous AI revision with paired, color-swapped games:

```bash
node scripts/elo_benchmark.mjs \
  --pairs 32 \
  --baseline-ref HEAD \
  --opening-plies 0,2,4,6,8,10
```

The arena gives both revisions the same seeded openings and both colors. It reports W/D/L, pentanomial pair
results, estimated Elo with a paired bootstrap 95% interval, illegal moves, and average search time. Search
errors count as losses instead of aborting the evidence run. Each AI receives the real Red or Blue state without
perspective normalization, so side-specific objective errors are exercised in the arena. Ultra receives a
deterministic virtual computation budget, so machine load cannot change the completed search depth; real wall
time is still reported separately.
The Pages workflow gates every deployment on unit tests, the tactical corpus, search-speed non-regression, and
32 paired games at each difficulty. Every difficulty and the aggregate result must pass independently. Reported
failures should also become fixtures in `web/fixtures/`; deterministic tactical tests and statistical match
tests cover different failure modes. Use `--difficulties ultra`, `--seed-offset N`, and `--ultra-time 1000` for
focused or larger-node-budget runs.

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
