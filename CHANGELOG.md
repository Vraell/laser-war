# Laser War Changelog

This is the canonical release history for Laser War. Keep user-visible changes,
important AI revisions, rule changes, regressions, and validation work here so
future releases can be compared against what actually shipped.

Dates and contents were reconstructed from the Git history. The application did
not preserve reliably recoverable version numbers before `v0.11.10`, so that
work is grouped under **Early development** rather than assigned invented
versions.

## Unreleased

No unreleased changes.

## [v0.13.0](https://github.com/Vraell/laser-war/commit/ccdcc50) - 2026-07-29

### Player sides

- Added a side selector for playing as Red, which moves first, or Blue, which
  moves second.
- Blue games use a fixed 180-degree board rotation for the entire match, like
  playing Black in chess. Coordinates, click targets, emitters, laser paths,
  impact effects, recent-move shading, and accessibility labels all follow the
  selected perspective.
- Persisted the selected side in resumable games and included the actual sides
  in match metadata and copied logs.

### Ultra and validation

- Added opening variety only among moves tied at the deepest completed root
  score. Ultra therefore changes openings without knowingly accepting a weaker
  evaluation.
- Tightened arena pass/fail reporting so every required strength, legality, and
  performance condition participates in the final result.
- Stabilized the speed gate with repeated samples and a median, reducing false
  regressions from one noisy timing run.
- Added perspective, persistence, translation, progress, AI tie-breaking, and
  arena regression tests.

## [v0.12.0](https://github.com/Vraell/laser-war/compare/c1cf824...1a75e2a) - 2026-07-29

### Ultra search

- Reworked Ultra around iterative deepening, principal-variation search,
  alpha-beta bounds, transposition-table bounds, history ordering, killer
  moves, and selective tactical extensions.
- Added an exhaustive legal mate-in-one pass before root pruning so immediate
  wins cannot disappear behind candidate selection.
- Ensured moves that alter a live laser remain in the searched tactical set,
  alongside the strongest quiet candidates.
- Audited the static evaluation around king cover, shield shape, independent
  laser reachability, exact route costs, and current king exposure. Simultaneous
  king exposure is evaluated as neutral because both lasers fire together.
- Kept the short forcing-line proof solver for offline analysis and tactical
  regressions. An always-on production proof prepass was removed after paired
  ablation games showed that normal search used the same budget more effectively.

### Speed and arena

- Optimized core state transitions, laser tracing, route checks, move
  generation, and search hot paths to reach more positions in the same time.
- Rebuilt the AI arena around paired, color-swapped games from identical seeded
  openings.
- Added pentanomial pair results, paired-bootstrap Elo intervals, illegal-move
  tracking, search-error losses, and average timing reports.
- Made Ultra arena runs use deterministic virtual computation budgets so
  machine load cannot silently change completed depth.
- Added fixed-depth throughput, tactical-corpus, arena-statistics, and
  previously lost-position regression gates to the deployment pipeline.

## [v0.11.19](https://github.com/Vraell/laser-war/commit/c1cf824) - 2026-07-26

- Preserved Ultra's safe-root filter at every iterative-deepening depth.
- Prevented a deeper partial iteration from reintroducing a move already proven
  to cause an avoidable self-loss or destructive shield sacrifice.

## [v0.11.18](https://github.com/Vraell/laser-war/commit/b314bd2) - 2026-07-26

- Added restrained variety among highly rated Ultra opening moves. This policy
  was later tightened in `v0.13.0` to exact deepest-score ties.
- Bounded the emergency survival probe so difficult positions could not freeze
  the worker indefinitely.

## [v0.11.17](https://github.com/Vraell/laser-war/commit/9c5d9db) - 2026-07-26

- Hardened Ultra's survival search against immediate tactical losses.
- Added regression coverage for the larger Ultra time budget and subsequently
  capped the survival probe to keep turns responsive.

## [v0.11.16](https://github.com/Vraell/laser-war/commit/9f28a4d) - 2026-07-26

- Rejected self-destructive root moves before ordinary positional comparison.
- Added explicit protection against needless destruction of Ultra's own king
  cover, including moves that looked active but opened a losing laser line.

## [v0.11.15](https://github.com/Vraell/laser-war/commit/aa5f21b) - 2026-07-26

- Reduced repeated work in Ultra's move ordering.
- Prioritized tactically relevant candidates earlier so completed depth improved
  without simply extending every turn to the time limit.

## [v0.11.14](https://github.com/Vraell/laser-war/commit/dd1a2aa) - 2026-07-26

- Added quiet-opening protection for shields covering Ultra's king.
- Penalized purposeless lines that consumed friendly cover before producing a
  concrete attack.

## [v0.11.13](https://github.com/Vraell/laser-war/commit/7bdc5d9) - 2026-07-26

- Made opening searches stop earlier when the position was quiet and stable.
- Retained larger budgets for developed or tactically unstable positions rather
  than making every Ultra move consume the maximum allowance.

## [v0.11.12](https://github.com/Vraell/laser-war/commit/3b96f1b) - 2026-07-26

- Strengthened Ultra's tactical defense using a recorded short-loss fixture.
- Added regressions for threats that combine shield destruction with a forced
  laser route.

## [v0.11.11](https://github.com/Vraell/laser-war/commit/784f16e) - 2026-07-26

- Doubled game sound volume.
- Refreshed web asset versions so browsers received the audio adjustment
  immediately.

## [v0.11.10](https://github.com/Vraell/laser-war/commit/70b0aa4) - 2026-07-26

- Replaced ambiguous Top/Bottom ownership language with Red/Blue throughout the
  game, saves, and translations.
- Clarified mirror ownership and laser geometry, especially at reflections
  where both sides of a mirror are active.
- Added the game version to persisted and copied match metadata.

## Early development - 2026-07-23 to 2026-07-25

Version numbers for this period are not reliably recoverable. The chronology
and features below are based on the commits that remain in the repository.

### Game foundation - July 23

- Built the original Python game, rules engine, desktop interface, match session,
  and initial computer opponent.
- Fixed laser reachability, tactical evaluation, undo/redo synchronization, and
  the crash caused by replaying stale AI moves.
- Limited undo and redo to the intended single move and retained the decisive
  laser volley on the result screen.
- Reworked typography and board presentation after the first playable builds.

### Rules and distribution - July 24 to 25

- Added the anti-fortress rule requiring viable king routes for both lasers,
  then replaced the early fixed mirror horizon with an exact compatible-route
  validator.
- Enforced king-adjacency and emitter-square restrictions and made forbidden
  squares visible after shields were destroyed.
- Published the browser game and initial desktop/Windows packages. Subsequent
  development consolidated on the static web application.
- Added responsive desktop/mobile layouts, English/French localization, legal
  move feedback, sound, animated impacts, retained end-state beams, local
  progress, and clipboard-ready match logs.

### Ultra and analysis - July 25

- Added unlockable Ultra difficulty and progressively hardened its iterative
  search, route control, tactical recovery, and legality handling.
- Moved AI work into a Web Worker, exposed live search progress, and fixed route
  solver stalls that could freeze a match.
- Added regression fixtures from real losses, AI-vs-AI Elo experiments, and a
  visual offline match analyzer with evaluation charts and board replay.
- Added tactical finish detection and short forcing-line proof search, while
  preserving the final laser path long enough to explain wins and losses.

## Maintaining This File

- Add changes to **Unreleased** while developing.
- On release, rename that section to the exact app version and date, then create
  a fresh empty **Unreleased** section.
- Record behavior and impact, not only filenames or commit titles.
- Include important rejected experiments when they explain why the shipped
  design is intentionally simpler.
- Never claim an Elo or speed improvement without recording the arena setup,
  sample size, and uncertainty.
