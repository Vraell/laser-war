# Tactical Potential Graph Evaluation

Date: 2026-08-03

## Decision

**Do not promote the full graph evaluator to every search leaf.** Promote it as an
offline labeler and selective root/tactical oracle, then require a positive result in
the hardened gameplay arena before production integration.

The prototype improves held-out tactical move ordering, but its tail latency is too
high and most nonterminal feature families are strongly redundant. This is evidence
for a search feature, not yet evidence for a universal static evaluation.

## Model

The prototype separates five concepts that the current route score conflates:

1. **Attack/defense tempo:** legal immediate wins and loaded next-volley threats.
2. **Unavoidable-threat certificates:** sound bounded `ThreatSpaceSearch` proofs.
3. **Defensive resources:** exact surviving reply moves, distinct squares, and
   orientation diversity after a loaded threat.
4. **Dual-laser assignment:** per-laser reachability masks, including the explicit
   `[blue-only, red-only]` case where each laser can reach exactly one king.
5. **Shield dependency graph:** repeated immutable-board volleys record which shield
   exposes the next shield or king, while enforceability gates its score.

Future-route distance is retained only as a weak prior. A route that is close in
geometry but has no legal threat receives 6% of its raw route value.

## Historical Ranking

The development fixture contains 110 legal moves. The held-out fixture partition
contains three different failure modes and 238 legal moves.

| Partition | Cases | Moves | Correct top move | Graph pairwise | Route-only | Gain |
|---|---:|---:|---:|---:|---:|---:|
| Development | 1 | 110 | 1/1 | 100.00% | 85.17% | +14.83 pp |
| Held-out | 3 | 238 | 3/3 | 88.83% | 80.59% | +8.24 pp |
| All | 4 | 348 | 4/4 | 91.62% | 81.73% | +9.89 pp |

Known move rankings:

| Case | Known defense/win | Reported blunder | Legal moves |
|---|---:|---:|---:|
| Root-shortlist mate defense | 7 | 28 | 110 |
| Only two-stage survival | 1 | 97 | 99 |
| Take mate in one | 1 | 7 | 40 |
| Avoid assignment concession | best safe move 1 | 93 | 99 |

The assignment-concession case is the hardest: pairwise accuracy rises from 41.76%
route-only to 66.48%. This is meaningful, but still insufficient as a standalone
assignment evaluator.

## Held-Out Ablations

| Removed family | Pairwise accuracy | Change from full |
|---|---:|---:|
| Nothing (full) | 88.83% | - |
| Terminal | 86.63% | -2.19 pp |
| Certificate | 88.92% | +0.09 pp |
| Tempo | 88.87% | +0.05 pp |
| Defensive resources | 88.83% | 0.00 pp |
| Assignment | 88.83% | 0.00 pp |
| Cascade | 88.83% | 0.00 pp |
| Route geometry | 88.76% | -0.07 pp |
| Shields | 88.80% | -0.02 pp |

Interpretation: terminal correctness is independently necessary. The tactical graph
families overlap heavily on this small fixture set, so no individual hand-set weight
has earned direct promotion. This agrees with the larger targeted data experiment:

| Family | Cross-validation contribution |
|---|---:|
| Route distance | +0.02286 |
| One-move enforceable routes | +0.01669 |
| Assignment | +0.00940 |
| Shields | +0.00536 |
| Shield contact | -0.00174 |
| Cascade | -0.00238 |
| Exposure | -0.00537 |

That experiment improved log loss from 0.65378 to 0.54329 on 378 held-out positions
(game-bootstrap improvement 95% interval 0.03554 to 0.18878), and from 0.63535 to
0.53680 on 923 independent positions (interval 0.06644 to 0.12984). It supports
route enforceability and defensive tempo, while warning against raw cascade weights.

## Adversarial Cases

- **Open but harmless:** nearest route cost 1, zero immediate wins, zero loaded
  threats. The graph does not call geometric openness an attack.
- **Enforceable route:** nearest route cost 0, eight legal wins, sound certificate.
- **Route-ranking trap:** route-only prefers a known blunder by 9 points; the graph
  reverses the pair.
- **Split singleton assignment:** exact masks `[1, 2]`; top/bottom scores are
  `-1711.87/+1711.87`, with zero color-antisymmetry error.
- **Cascade decoy:** one shield-to-king dependency chain, five defensive moves, and
  no proof certificate. Cascade geometry alone is not declared forced.

## Runtime

| Pass | Median | p95 | Maximum | 348-move benchmark |
|---|---:|---:|---:|---:|
| Cold observed | 3.72 ms | 42.77 ms | 728.87 ms | 30.28 s |
| Repeat observed | 0.97 ms | 8.88 ms | 149.56 ms | 9.72 s |

Even the repeat p95 is too expensive for every leaf in a JavaScript alpha-beta
search. The model is suitable for a small root set, tactical instability checks,
offline position labeling, and selective extension triggers.

## Quantified Recommendation

1. **Promote to an arena candidate:** gate route value by legal loaded threats and
   defensive reply counts at the root and unstable tactical nodes only.
2. **Use certificates selectively:** run proof search only when a live beam, shield
   cascade, or singleton assignment supplies a concrete trigger.
3. **Keep assignment vector-valued:** preserve each laser's target mask and tempo;
   do not collapse `[1, 2]` into a generic bonus.
4. **Do not add a raw cascade score:** use the dependency graph for move ordering and
   training labels until an arena demonstrates independent Elo gain.
5. **Release gate:** zero invalid games and accepted positive-Elo SPRT against the
   immutable baseline. Move-ranking accuracy alone is not an Elo result.

## Artifacts

- `experiments/eval_tactical_graph_model.mjs`
- `experiments/eval_tactical_graph_cases.mjs`
- `experiments/eval_tactical_graph_results.json`
- `experiments/eval_tactical_graph_report.md`
- `scripts/eval_tactical_graph_benchmark.mjs`
- `scripts/eval_tactical_graph_test.mjs`

Production `web/ai.js` was not edited by this experiment.
