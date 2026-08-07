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
- animated simultaneous lasers, impacts, a multi-cue sound system, and a
  retained final volley;
- legal-move feedback and forbidden-square markings;
- a shared-route anti-fortress rule that keeps both kings and both lasers viable;
- automatic in-browser match saves and a clipboard-ready match log.

Ultra unlocks after defeating Hard. Progress and the current match are stored locally in the browser and
survive game updates.

Ultra combines iterative deepening, principal-variation alpha-beta search, transposition bounds, history and
killer ordering, late-move reductions, and lazy child validation. It checks every legal mate-in-one before root
pruning, preserves forcing live-beam moves, and rejects roots that allow an immediate legal king hit when a safe
alternative exists. A bounded threat-space prepass proves short forcing attacks in tactical positions, while an
exact late-game solver replaces heuristic search when the remaining tree is small enough. Quiet turns target
four seconds; developed or unstable positions can progressively use six, eight, or at most ten seconds. Search
runs in a Web Worker and keeps the interface responsive. Turn-local ordering and partial-search state are reset
before every move so stale evidence cannot hide a new tactic.
During quiet openings, Ultra varies its play only among moves tied in both the deepest completed root score and
the strategic evaluation, with no worse immediate shield exchange. This provides different games without
using a shallow search tie to select a strategically weaker move.

The static evaluation is intentionally small and auditable. Its coefficients were fitted on independently held
out games with monotonic sign constraints, then screened through tactical and arena tests. It scores surviving
friendly and opposing shields, the nearest and reserve laser-route distances to each king, one-move attacking
and defensive routes, and live contact with friendly shields. Internal speculative nodes use a constructive
bounded route witness; root moves and the returned move still receive the authoritative exact legality check.

## Evaluation Reference

The complete evaluation is documented as pure game logic, with every term, sign convention, weight, and a
worked numerical example: [LaTeX source](docs/ULTRA_EVALUATION.tex) and
[PDF](docs/ULTRA_EVALUATION.pdf). The release tests compare the document's version and weights with the game,
so either must be updated whenever the evaluation changes.

Promising engine experiments, including measured results and explicit promotion criteria, are preserved in the
[AI research roadmap](docs/AI_RESEARCH_ROADMAP.md). Failed or inconclusive ideas remain there so future work can
build on evidence instead of repeating it.

## Release History

See [CHANGELOG.md](CHANGELOG.md) for semi-detailed patch notes from the first playable build through the current
release. Early entries are reconstructed from Git history, and future work is recorded under `Unreleased` before
shipping.

## Development

The application is static HTML, CSS, and JavaScript. No package installation or compilation is required.

Run all tests and tactical regressions:

```bash
node --test web/*.test.mjs scripts/arena_stats.test.mjs scripts/arena_integrity.test.mjs
node scripts/tactical_benchmark.mjs
```

Check fixed-depth search throughput against a Git revision:

```bash
node scripts/search_benchmark.mjs HEAD --gate=nonregression
```

Compare every difficulty against a previous AI revision with paired, color-swapped games:

```bash
node scripts/elo_benchmark.mjs \
  --pairs 64 \
  --baseline-ref HEAD \
  --opening-plies 0,2,4,6,8,10 \
  --resource nodes \
  --ultra-nodes 20000 \
  --openings mixed
```

The arena gives both revisions the same seeded openings and both colors. It reports W/D/L, pentanomial pair
results, estimated Elo with a paired-bootstrap 95% interval, illegal moves, operational failures, and average
search time. Any candidate illegal move, exception, truncated pair, or
malformed child result invalidates the entire batch; partial candidate games cannot become strength evidence.
Time-budgeted runs also enforce the production 11-second move clock, with a reference-engine operational failure
recorded as an explicit forfeit. Each AI receives the real
Red or Blue state without perspective normalization, so side-specific objective errors are exercised directly.
Ultra pairs run in bounded isolated chunks. An immutable candidate snapshot, semantic rule hash, executable-
bundle hashes, operation counter, and run manifest make each comparison reproducible. A known-inferior candidate
must fail the integrity suite.

The Pages workflow gates every deployment on unit tests, arena-integrity qualification, the tactical corpus,
search-speed non-regression, 64 paired mixed-opening games for Easy, Medium, and Hard, 32 Ultra mixed-opening
pairs, and 16 additional Ultra pairs from an independent confirmation set. Ultra qualification is split into six
independent hosted-runner shards, then reconstructed by a fail-closed aggregation step that rejects gaps,
overlaps, duplicate openings, changed source or harness hashes, mismatched budgets and opening schedules, or
missing results. Every difficulty and aggregate result
must pass independently.
Ultra strength comparisons use a deterministic computation budget so machine load cannot change completed work.
Wall-clock performance is enforced independently by the search-speed gate and bounded arena child processes;
time-budgeted diagnostic runs additionally enforce the production move watchdog. Reported failures should become fixtures
in `web/fixtures/`; deterministic tactical tests and statistical match tests cover different failure modes. Use
`--difficulties ultra`, `--seed-offset N`, and `--ultra-nodes N` for focused or larger-budget runs.

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
