# Laser War AI Research Roadmap

This file preserves promising engine work that is not yet qualified for production. A research result enters
Ultra only after deterministic tactical tests, fixed-budget speed tests, and paired arena confirmation on both
public and holdout openings.

## Highest Priority

### Selective tactical-potential graph

Status: promising arena candidate, not shipped.

- Held-out move-ranking accuracy improved from 80.59% to 88.83% across 238 moves.
- It corrected all three held-out historical decisions and reversed a route-only ranking trap.
- Full leaf use is too expensive: repeat p95 was 8.88 ms and the observed maximum was 149.56 ms per evaluation.
- Next experiment: apply the graph only to a small root set and unstable tactical nodes, then require positive
  paired Elo and zero watchdog failures.
- Artifacts: `experiments/eval_tactical_graph_*` and `scripts/eval_tactical_graph_*`.

### Response-expanded opening policy

Status: useful compression, insufficient generalization.

- Symmetry canonicalization reduced 276 source positions to 157 states, a 43.1% reduction.
- A 96-entry book covered every historical position through ply 5, but only 6.8% of held-out self-play states.
- Depth-3 certification produced 57.9% zero-regret moves; wider auditing reached 76.9%.
- Next experiment: expand opponent responses, certify all retained roots, and test against unseen openings.
- Preserved branch: `experiment/opening-policy-book`, commit `1a8b420`.

### Native search core and compact board representation

Status: design target.

- Port beam tracing, route costs, position hashing, and move generation to packed integer/bitboard structures.
- Evaluate WebAssembly only after a JavaScript packed-board prototype establishes the algorithmic baseline.
- Preserve the JavaScript rules engine as the cross-checked reference implementation.
- Required result: at least 3x end-to-end positions per second with identical legal moves and outcomes on the
  complete fixture corpus. A 10x target remains desirable but is not assumed.

## Tactical Solvers

### Threat-space proof search

Status: bounded production prepass and offline tool shipped in v0.14.0.

- Verified 11 of 11 returned proofs independently on an 18-position corpus.
- Used 2.34x fewer nodes and about 3.2x less wall time than the earlier tactical search.
- Unknown remains a first-class result and is never treated as a refutation.
- Next experiment: proof-number node selection and transposition-aware defense sets.
- Artifacts: `experiments/threat_proof_search*` and `web/tactics.js`.

### Exact late-game solver

Status: selectively shipped in v0.14.0.

- Solved 33 of 92 sampled late positions exactly, including all 10 dense late fixtures.
- Worst qualifying sample used 311 nodes and 16.7 ms.
- Interrupted searches return unknown and never write an exact table entry.
- Next experiment: retrograde tablebase generation for canonical positions with at most 14 empty squares.
- Artifacts: `web/endgame.js` and `web/endgame.test.mjs`.

### Joint-route tactical oracle

Status: validated prototype, not used at every search leaf.

- Exact route agreement was 15 of 15 positions and individual cost agreement was 50 of 50 queries.
- Mean cost was about 4.26 ms per candidate.
- On the 13-move loss, the safe defense ranked 4th of 110 while the blunder ranked 33rd.
- Next experiment: root ordering and selective extension triggers only.
- Artifacts: `experiments/joint_route_*` and `scripts/joint_route_experiment.mjs`.

## Evaluation Research

### Monotonic outcome-fitted evaluator

Status: v0.14.0 release candidate after tactical qualification; paired Elo remains the promotion gate.

- Holdout log-loss improvement: 0.06831, 95% game-bootstrap interval 0.01992 to 0.11430.
- Independent log-loss improvement: 0.10066; accuracy improved from 66.9% to 72.0%.
- Retained families: shield counts, route distance, one-move routes, and friendly shield contact.
- Rejected families: raw assignment, exposure, and cascade terms after conditional ablation.
- The original 32-game evaluator-only arena was +10.9 Elo with a wide interval, so future tuning must continue
  to use larger paired confirmation runs.
- Preserved branch: `experiment/data-driven-eval`, commit `813ba6d`.

### Learned residual value model

Status: rejected for production, preserved for future data work.

- Test log loss improved from 0.6018 to 0.5672, but the bootstrap interval crossed zero.
- It regressed exposed-king, shield-cascade, and dedicated-laser cohorts.
- Route features were the only large ablation contribution (+0.0618).
- Next experiment: obtain more independent rare tactical games before fitting any residual model.
- Artifacts: `experiments/eval_learned_value_*` and `scripts/eval_learned_value_run.mjs`.

## Arena Research

- Add a reviewed reference implementation of pentanomial GSPRT before using sequential stopping for releases.
- Keep fixed-size paired bootstrap gates until reference vectors and error-rate simulations exist.
- Maintain two opening sets: public development openings and an independent confirmation set spanning quiet,
  asymmetric, damaged-shield, live-beam, side-inverted, and late positions.
- Qualify every harness revision with an identical engine that must pass and a known-inferior engine that must
  fail. Include the judge, policy, engine bundles, and opening identities in the run manifest.
- Add a separately enforced real-time arena for time-management changes; deterministic work and wall-clock
  speed answer different questions.
