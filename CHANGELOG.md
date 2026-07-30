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

## v0.13.4 - 2026-07-30

### Ultra AI

- Added permanent laser assignment to the strategic evaluation. A laser that
  can reach only the opposing king is now worth `+1200`; one permanently
  committed to Ultra's own king is worth `-1200`.
- Added a root safety pass that rejects moves allowing the opponent to claim a
  permanent assignment when a safe alternative exists. This fixes the reported
  26-ply loss at its real turning point, move 16, rather than treating the final
  king hit as the mistake.
- Exact legality now confirms concrete assignment threats and remains the final
  emergency fallback when the bounded route witness finds no move.
- Kept exact route validation for concrete tactical candidates and
  only-surviving defenses, while speculative leaf scoring now relies on sound
  constructive route witnesses. It no longer starts an uninterruptible exact
  route proof from every speculative leaf.
- Added iteration-cost prediction before deeper searches. On the reported
  position Ultra now completes depth 4 and selects a safe move in about three
  seconds instead of entering a depth-5 iteration that reached the 11-second
  browser watchdog.

### Arena and tests

- Isolated each difficulty in its own arena process and split Ultra matches
  into bounded concurrent chunks. Missing or malformed child results now fail
  the run, preventing a long legacy route-solver process from silently omitting
  Ultra while the overall gate appears to pass.
- Preserved the global seeded-opening sequence across chunks, failed candidate
  moves that exceed the production 11-second watchdog, and added a hard
  two-minute process timeout so a stuck solver cannot hang the pipeline.
- Added the reported loss as a deterministic fixture. The test proves that the
  logged move concedes a permanent assignment and that Ultra's replacement
  move does not.
- Passed all 12 automated test suites, the 307-ply tactical corpus, route-solver
  regressions, fixed-depth speed non-regression, the staged Pages artifact
  check, and the full four-difficulty arena.

#### Arena strength

Measured against `v0.13.3` over 32 paired openings per difficulty (64 games
each, colors swapped within every pair). Intervals are 95% paired-bootstrap
confidence intervals. These are relative Elo changes, not absolute ratings.

| Difficulty | Candidate W-D-L | Estimated Elo change | 95% interval |
| --- | ---: | ---: | ---: |
| Easy | 30-4-30 | 0 | 0 to 0 |
| Medium | 30-4-30 | 0 | 0 to 0 |
| Hard | 30-4-30 | 0 | 0 to 0 |
| Ultra | 31-3-30 | +5 | -49 to +60 |

Ultra averaged 19.7 ms per move versus 20.7 ms for `v0.13.3` under the arena's
deterministic computation budget.

### Documentation

- Added a maintained LaTeX and PDF reference for the pure evaluation logic,
  including every term, weight, sign convention, and a worked example.
- Added a release test that requires the document's version and weights to
  match the game, and included the PDF in the deployed Pages artifact.

## v0.13.3 - 2026-07-29

### Presentation

- Replaced the main-menu backdrop with new cinematic Laser War key art built
  around the game's kings, shields, mirrors, neutral laser beams, and a more
  restrained fog-lit tactical-board composition.
- Rebuilt the mirror selector as a pair of dimensional mirror controls rather
  than text glyphs. Selection now uses a consistent accent rail and remains
  immediately visible on touch devices.
- Tightened the menu, match sidebar, button, status, and result hierarchy across
  desktop and mobile. Turn ownership now colors a restrained status edge
  instead of tinting the whole interface.
- Removed the lingering occupied-cell hover outline. Illegal placements are
  explained by the existing localized toast without leaving a false board
  selection behind.
- Replaced the musical-note sound control with the familiar Lucide volume icon
  and included its upstream license in the deployment artifact.

### Sound and feedback

- Added a persistent sound control to both the main menu and match screen.
- Expanded the procedural sound set with distinct cues for selection,
  confirmation, panel changes, shield impact, illegal moves, turn handoff, log
  copy, victory, defeat, and draws, while retaining the original clean
  single-sweep laser sound.
- Differentiated terminal audio so a defeat or draw no longer reuses the victory
  cue.
- Added restrained warning and success treatments to transient messages while
  keeping them clear of the board.

### Validation

- Audited the menu, rules, active match, AI turn, red and blue perspectives,
  copied logs, illegal moves, saved language and sound preferences, and
  terminal match state in desktop and mobile browsers.
- Verified that the final volley remains visible on the result screen and that
  every board square is locked after the match ends.
- Passed all 11 automated test suites, the 281-ply tactical corpus, the fixed
  depth search-speed gate, the staged Pages artifact check, and the full
  four-difficulty arena.

#### Arena strength

Measured against `v0.13.2` over 32 paired openings per difficulty (64 games
each, colors swapped within every pair). Intervals are 95% paired-bootstrap
confidence intervals. These are relative Elo changes, not absolute ratings.

| Difficulty | Candidate W-D-L | Estimated Elo change | 95% interval |
| --- | ---: | ---: | ---: |
| Easy | 30-4-30 | 0 | 0 to 0 |
| Medium | 30-4-30 | 0 | 0 to 0 |
| Hard | 30-4-30 | 0 | 0 to 0 |
| Ultra | 30-4-30 | 0 | 0 to 0 |

The AI, rules, and move selection are unchanged in this presentation release,
so the deterministic arena is exactly neutral.

## v0.13.2 - 2026-07-29

### Fixed

- Cleared Ultra's turn-local history, killer moves, root ordering, partial child
  lists, tactical verdicts, and evaluation caches before every new move.
  Retaining them across turns could change selective root membership, hide a
  forcing win, and make a later move consume the full browser watchdog.
- Kept the engine's exact route witnesses shared because those immutable board
  results remain sound; only search heuristics and partial search products are
  isolated per turn.
- Bumped browser cache keys so active installations receive the corrected
  worker and AI modules.
- Set the laser volley to 0.8 seconds of travel and 1.3 seconds of total display,
  and replaced the single moving beam highlight with five evenly spaced
  particles.

### Validation

- Added the reported 14-ply game as a deterministic persistent-search
  regression. Ultra must find `R3C8 /` with a forcing score after analyzing all
  preceding computer turns.

#### Arena strength

Measured against `v0.13.1` over 32 paired openings per difficulty (64 games
each, colors swapped within every pair). Intervals are 95% paired-bootstrap
confidence intervals. These are relative Elo changes, not absolute ratings.

| Difficulty | Candidate W-D-L | Estimated Elo change | 95% interval |
| --- | ---: | ---: | ---: |
| Easy | 30-4-30 | 0 | 0 to 0 |
| Medium | 30-4-30 | 0 | 0 to 0 |
| Hard | 30-4-30 | 0 | 0 to 0 |
| Ultra | 30-4-30 | 0 | 0 to 0 |

The deterministic arena did not reach the reported forcing position, so the
paired result is exactly neutral. The dedicated replay distinguishes the
versions: `v0.13.2` proves the forcing line after the prior turns, while the old
retained heuristics miss it.

## v0.13.1 - 2026-07-29

### Fixed

- Fixed Easy, Medium, and Hard evaluating every position as Blue. When the
  computer played Red, this reversed its objective and could make it attack its
  own king or prefer a human win.
- Replaced hard-coded Blue-win and Red-win checks in standard reply search with
  checks relative to the actual computer side.
- Replaced the route validator's global incremental MiniSat instance with
  isolated per-query formulas. Unrelated positions could previously accumulate
  learned clauses until one legality check blocked the Ultra worker for minutes,
  beyond its nominal search deadline.
- Canonicalized exact formulas across horizontal and vertical board symmetries,
  then transforms valid witnesses back to the played orientation. The reported
  hard UNSAT query fell from roughly 12.7 seconds to under 0.1 seconds without a
  mirror horizon or approximate legality decision.
- Ultra now publishes its latest fully validated completed result while
  searching. An 11-second interface watchdog terminates an overrun worker and
  plays that result, providing a hard recovery path around synchronous solver
  stalls.
- Bumped all browser module cache keys so existing players receive the corrected
  AI immediately.

### Validation

- Removed the arena's Red-to-Blue perspective normalization. Paired games now
  call each AI with the real side-to-move state, matching production behavior.
- Expanded the deployment arena from Ultra-only to 32 paired games at every
  difficulty, with each difficulty required to pass independently.
- Added direct objective tests for Easy, Medium, and Hard as both Red and Blue.
- Added a color-inverted real self-loss regression for Hard and a color-inverted
  mate-in-one regression for Ultra.
- Added the reported 11-move freeze as a fixture and a subprocess-bounded route
  stress test, preventing a solver regression from hanging CI indefinitely.

#### Arena strength

Measured against `v0.13.0` over 32 paired openings per difficulty (64 games
each, colors swapped within every pair). Intervals are 95% paired-bootstrap
confidence intervals. These are relative Elo changes, not absolute ratings.

| Difficulty | Candidate W-D-L | Estimated Elo change | 95% interval |
| --- | ---: | ---: | ---: |
| Easy | 47-3-14 | +198 | +124 to +293 |
| Medium | 52-3-9 | +283 | +191 to +411 |
| Hard | 51-3-10 | +264 | +177 to +379 |
| Ultra | 30-4-30 | 0 | 0 to 0 |

Ultra's playing policy is unchanged in this release, so its exactly even result
is expected. Its exact legality solver and worker reliability changed, while
Easy, Medium, and Hard gained strength from evaluating the correct side.

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

#### Arena strength

Reliable per-difficulty Elo estimates are unavailable for this historical
release. Its arena normalized Red positions to Blue before calling the AI,
which concealed the side-selection regression fixed in `v0.13.1`.

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

### Ultra and analysis - July 25

- Added unlockable Ultra difficulty and progressively hardened its iterative
  search, route control, tactical recovery, and legality handling.
- Moved AI work into a Web Worker, exposed live search progress, and fixed route
  solver stalls that could freeze a match.
- Added regression fixtures from real losses, AI-vs-AI Elo experiments, and a
  visual offline match analyzer with evaluation charts and board replay.
- Added tactical finish detection and short forcing-line proof search, while
  preserving the final laser path long enough to explain wins and losses.

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

### Game foundation - July 23

- Built the original Python game, rules engine, desktop interface, match session,
  and initial computer opponent.
- Fixed laser reachability, tactical evaluation, undo/redo synchronization, and
  the crash caused by replaying stale AI moves.
- Limited undo and redo to the intended single move and retained the decisive
  laser volley on the result screen.
- Reworked typography and board presentation after the first playable builds.

## Maintaining This File

- Add changes to **Unreleased** while developing.
- On release, rename that section to the exact app version and date, then create
  a fresh empty **Unreleased** section.
- Record behavior and impact, not only filenames or commit titles.
- Include important rejected experiments when they explain why the shipped
  design is intentionally simpler.
- Every release must report arena-based estimates for Easy, Medium, Hard, and
  Ultra, including the comparison baseline, paired sample size, W-D-L result,
  and 95% interval. Explicitly mark unavailable or invalid historical data
  rather than inventing a rating.
- Never claim an Elo or speed improvement without recording the arena setup,
  sample size, and uncertainty.
