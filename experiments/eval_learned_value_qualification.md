# Learned value release qualification

## Decision

**Do not promote this candidate to production.** Keep `eval_learned_value_candidate.json` as an arena-ready diagnostic payload only.

Production `web/ai.js` was not edited.

## Quantified held-out result

The preserved valid run used independent seeds and complete-game partitions:

- Train: 72 self-play games, 76 total groups, 1,192 augmented rows.
- Validation: 32 self-play games, 35 total groups, 556 augmented rows.
- Untouched test: 40 self-play games, 42 total groups, 590 augmented rows.
- Rotation/color augmentation residual: exactly 0.

| Model | Test log loss | Test Brier | Accuracy | Calibration error |
|---|---:|---:|---:|---:|
| Calibrated incumbent | 0.6018 | 0.2015 | 71.0% | 10.5% |
| Learned monotonic | 0.5672 | 0.1844 | 65.9% | 10.0% |

The learned model improved paired test log loss by **0.0346**, but the complete-game bootstrap 95% confidence interval was **-0.0095 to 0.0739**. The mean is favorable; the evidence does not exclude a regression.

## Ablations

Positive contribution means the untouched-test score became worse when that family was removed.

| Removed family | Test log loss without family | Contribution |
|---|---:|---:|
| Route tempo and one-move routes | 0.6291 | +0.0618 |
| Shields | 0.5764 | +0.0092 |
| Dedicated-laser assignment | 0.5726 | +0.0053 |
| Exposed king | 0.5696 | +0.0024 |
| Live shield contact | 0.5679 | +0.0006 |
| Shield cascade | 0.5670 | -0.0002 |

The robust signal is route pressure. Assignment, exposure, contact, and cascade are too weak or sparse to justify production weights from this dataset.

## Rare-state qualification

| Cohort | Test groups | Incumbent log loss | Candidate log loss | Result |
|---|---:|---:|---:|---|
| Dedicated laser | 1 | 0.0006 | 0.0052 | insufficient coverage; worse |
| Exposed king | 35 | 0.6280 | 0.6626 | regression |
| Shield cascade | 13 | 0.5556 | 0.5590 | slight regression |
| Forced defense | 20 | 0.4697 | 0.4632 | slight improvement |

The diversified dedicated-state rerun was rejected after exposing numerical separation in baseline calibration. The fitter now bounds non-finite Newton steps and has a regression test, but no replacement full qualification was accepted inside this release window. The preserved run therefore remains explicitly non-promotable.

## Runtime

- Cold feature extraction: 66.9 microseconds per position.
- Cache-warmed extraction: 1.9 microseconds per position.
- Model: eight signed linear features plus one intercept; all feature weights are constrained monotonic.

## Promotion requirements

1. Obtain at least 20 independent training and 10 independent test groups for dedicated-laser states.
2. Reverse the exposed-king and cascade cohort regressions without harming route performance.
3. Repeat the untouched test on multiple independent seeds and require the paired 95% lower bound to exceed zero.
4. Only then run the candidate in the fixed-node Elo arena against the frozen incumbent.
