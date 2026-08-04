# Joint two-laser route experiment

## Question

Can Ultra replace or supplement four independent laser-to-king distances with a
cheap model of two routes that must coexist on one future board?

## Model

Each single-laser route records four bit masks: squares that must remain empty,
squares that require `/`, squares that require `\`, and shields that must first be
cleared. Two routes are compatible only when neither route needs a mirror where
the other must travel straight and they never require opposite mirror
orientations on the same square.

Compatible pairs are summarized as:

- **Attack tempo:** fewest future actions on the route to the opposing king.
- **Danger tempo:** fewest future actions on the route to the evaluating side's king.
- **Assignment compatibility:** minimum joint action count for left-to-top/right-to-bottom
  and left-to-bottom/right-to-top.
- **Route redundancy:** distinct near-optimal compatible routes toward each king.

The model obeys the engine's king-adjacent and laser-entry mirror restrictions.
Shield clearing and shared mirror placements are counted once in joint cost.

## Results

Measurements are from `scripts/joint_route_experiment.mjs` on the current
checkout. The bounded search preset uses eight route plans per laser/king target.

| Check | Result |
| --- | ---: |
| Exact joint-route availability agreement | 15/15 historical late-game states |
| Individual shortest-cost agreement in range | 50/50 routes |
| Median bounded runtime | 4.26 ms per cold position |
| Move 12 surviving defense rank | 4/110 |
| Move 12 mate-conceding blunder rank | 33/110 |
| Move 6 analyzed defense rank | 73/120 |
| Move 6 played move rank | 69/120 |

At move 12 of `ultra_loss_13_move_log.json`, the played `/ R2C2` has attack/danger
tempo `3/1` and joint score `-244`; the surviving `\ R4C7` has tempo `2/2` and
joint score `4`. This is useful, independent information for tactical root
ordering.

At move 6, both candidates have a `0` route race and the experimental score
correctly remains tied. The stronger `/ R5C7` does expose a cheaper compatible
assignment (`4/6` actions versus `5/5`), but that fact alone is not directionally
favorable. Shield consequences and tactical search must decide the move.

## Recommendation

Do not replace the leaf evaluation with this prototype. At roughly 4-5 ms per
position it is too expensive at every node, and route redundancy is necessarily
bounded. Trial it as a cached root-ordering feature and at tactically unstable
principal-variation nodes. Keep one-ply mate survival exhaustive; a heuristic
route model must never substitute for that invariant.

The next production experiment should ablate three variants in the arena:

1. Current Ultra baseline.
2. Baseline plus joint-route root ordering.
3. Variant 2 plus selective principal-variation extension when danger tempo is 1-2.

Accept the feature only if tactical coverage, wall-clock search depth, and paired
Elo all improve.
