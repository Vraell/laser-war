# Laser War Threat-Space Search Experiment

Date: 2026-08-03

## Objective

Test whether a sound game-specific tactical solver can prove forcing Laser War wins and reject losing defenses
faster than the production `TacticalProofSearch`, without changing the production engine.

## Prototype

The experiment implements two related solvers:

1. **Threat proof-number search** builds an AND/OR tree and expands the unresolved node that currently controls
   the root proof number. Exact anti-fortress legality is checked lazily when an edge can affect the proof.
2. **Compact threat-space search** uses memoized depth-first AND/OR search over the same threat model. It avoids
   the explicit proof-number tree's object and memory overhead while retaining a complete proof certificate.

An attacking candidate must alter a live volley and either win, expose the defending king after damage, or
destroy a shield. This captures immediate wins and multi-stage shield breakthroughs. It intentionally omits
quiet preparations.

When only the defender's king is exposed, a move outside both current beam paths cannot change either beam.
Such a move still loses immediately, so only live-volley defensive replies require recursive search. The
reduction is disabled when both kings are exposed because an off-beam reply may then preserve a draw.

## Soundness Contract

- `proven` means every authoritative legal defense in the returned certificate loses within the ply bound.
- `unknown` does **not** mean safe or drawn. Attacker move filtering makes the search intentionally incomplete.
- Candidate states use relaxed joint-path generation for speed, but every proof-relevant edge receives exact
  anti-fortress validation before it can prove the root.
- An independent verifier regenerates all fully legal moves at every certificate node. It accepts omitted
  defensive replies only when the exposed-volley rule applies and the authoritative child is an immediate win.
- No production result should consume an unverified experimental certificate.

## Benchmark

Command:

```sh
node experiments/benchmark_threat_proof.mjs --nodes=25000 --ms=750 --windows=1,3,5
```

The corpus contains 18 one-, three-, and five-ply windows from every still-valid decisive historical fixture,
including `ultra_loss_13_move_log.json`.

| Position | Bound | Existing DFS | Proof-number | Threat-space DFS |
|---|---:|---:|---:|---:|
| `ultra_loss_15` | 3 | 277 nodes / 16 ms | 132 / 30 ms | **27 / 3 ms** |
| `ultra_loss_reversed_28` | 3 | 246 / 71 ms | 235 / 37 ms | **164 / 11 ms** |
| `ultra_root_pruning_31` | 5 | 5,988 / 407 ms | 971 / 602 ms | **1,002 / 106 ms** |
| `ultra_loss_25` | 3 | 170 / 49 ms | 175 / 26 ms | 327 / 33 ms |

Under the shared limits:

- Existing DFS proved 11 of 18 positions.
- Proof-number search proved the same 11; all 11 certificates verified.
- Threat-space DFS proved the same 11; all 11 certificates verified.
- On positions both could prove, threat-space DFS used **2.34x fewer nodes on average** and was **3.20x faster
  on average** for non-trivial timed cases.
- Proof-number search used 1.81x fewer expanded nodes on average, but its explicit tree was slower on the
  largest five-ply proof. In this JavaScript engine it is a useful search-policy experiment, not the preferred
  production implementation.

Timings are single-process development-machine measurements and vary with JIT warm-up. Node counts and proof
verification are the more stable evidence.

## Thirteen-Move Loss

At the position before Ultra's twelfth move:

- 110 legal replies exist.
- 102 allow a verified opposing mate in one.
- 8 survive the immediate threat.
- The played `/ at R2C2` is a proven mate-in-one concession.
- `\\ at R4C7` is one verified immediate survivor.

The earlier game is not proven lost within the tested threat space. The concrete failure is therefore defensive
move selection: Ultra chose from a very large losing class despite eight available tactical escapes.

## Failures And Limits

- Quiet preparations are omitted. A forced win that needs a non-destructive setup returns `unknown`.
- Several five-ply positions remain unresolved within 750 ms. The prototype never promotes those timeouts to
  losses or draws.
- Proof-number search creates many JavaScript objects. Its lower expansion count does not consistently become
  lower wall-clock time.
- The current threat definition treats every shield destruction as potentially relevant. A later experiment
  should rank or prune destructions using king-route dependency, while retaining certificate verification.

## Production Recommendation

Use the compact threat-space solver as a bounded tactical oracle before or beside the main alpha-beta search:

1. Exhaustively take immediate wins and reject mate-in-one concessions at the root.
2. Run verified destructive threat-space search in tactical positions.
3. Feed a proven line into normal move ordering; never convert `unknown` into an evaluation score.
4. Keep proof-number search for offline diagnosis or revisit it only after adopting a compact arena/typed-array
   node representation.

## Files

- `experiments/threat_proof_search.mjs`
- `experiments/threat_proof_search.test.mjs`
- `experiments/benchmark_threat_proof.mjs`
- `experiments/THREAT_SEARCH_REPORT.md`

Production `web/ai.js` and `web/engine.js` were not edited by this experiment.
