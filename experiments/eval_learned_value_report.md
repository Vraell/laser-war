# Learned monotonic value experiment

Production AI code was not edited. This experiment fits a compact side-to-move value model from complete self-play games and replayable historical fixtures, calibrates it on a separate validation seed, and evaluates it once on an untouched test seed.

## Data discipline

| Partition | Self-play games | Seed | Raw sampled rows | With rotation/color augmentation | Outcomes top/bottom/draw/unfinished |
|---|---:|---:|---:|---:|---:|
| train | 72 | 430108691 | 503 | 1006 | 37/32/3/0 |
| validation | 32 | 1803866639 | 172 | 344 | 19/12/1/0 |
| test | 40 | 3576789649 | 244 | 488 | 24/15/1/0 |

- Final rows: train 1192, validation 556, test 590.
- Complete-game groups: train 76, validation 35, test 42.
- Maximum rotation/color feature residual: 0.00e+0.
- Historical fixtures are included only when they replay legally to a terminal result; all exclusions are listed in the JSON summary.
- Regularization was selected by grouped four-fold cross-validation inside training. Validation was then used only for positive-slope probability calibration. Test was untouched until final scoring.

## Held-out evidence

| Model | Train log loss | Validation log loss | Test log loss | Test Brier | Test accuracy | Test calibration error |
|---|---:|---:|---:|---:|---:|---:|
| Calibrated incumbent | 0.6528 | 0.6113 | 0.6018 | 0.2015 | 71.0% | 10.5% |
| Learned monotonic | 0.5952 | 0.5384 | 0.5672 | 0.1844 | 65.9% | 10.0% |

Paired test log-loss improvement: **0.0346**, game-bootstrap 95% CI **-0.0095 to 0.0739** across 42 complete games.

## Ablations

Positive contribution means removing that family made untouched-test log loss worse. Test values are diagnostics; feature definitions and model selection were frozen before test scoring.

| Removed family | Features | Test log loss | Full-model contribution |
|---|---|---:|---:|
| shields | shieldBalance | 0.5764 | 0.0092 |
| routes | attackTempo, reserveTempo, oneMoveRouteBalance | 0.6291 | 0.0618 |
| assignment | dedicatedLaserBalance | 0.5726 | 0.0053 |
| exposure | liveKingBalance | 0.5696 | 0.0024 |
| cascade | cascadeKingBalance | 0.5670 | -0.0002 |
| contact | liveShieldBalance | 0.5679 | 0.0006 |

## Coefficients

Every feature is signed so that larger is better for the side to move and constrained nonnegative. Intervals resample complete training games.

| Feature | Calibrated log-odds weight | 2.5% | 97.5% | Bootstrap at zero |
|---|---:|---:|---:|---:|
| shieldBalance | 0.19647 | 0.00000 | 0.47428 | 3.8% |
| attackTempo | 0.28858 | 0.12878 | 0.43489 | 0.0% |
| reserveTempo | 0.34682 | 0.14672 | 0.68368 | 0.0% |
| dedicatedLaserBalance | 0.00000 | 0.00000 | 1.62501 | 76.3% |
| oneMoveRouteBalance | 1.01428 | 0.74209 | 1.26979 | 0.0% |
| liveKingBalance | 0.00000 | 0.00000 | 0.33283 | 68.8% |
| cascadeKingBalance | 0.00000 | 0.00000 | 0.48764 | 82.5% |
| liveShieldBalance | 0.30341 | 0.00000 | 0.83924 | 11.3% |

## Dedicated tactical cohorts

| Cohort | Rows | Games | Incumbent log loss | Candidate log loss | Improvement |
|---|---:|---:|---:|---:|---:|
| dedicatedLaser | 13 | 1 | 0.0006 | 0.0052 | -0.0046 |
| exposedKing | 44 | 35 | 0.6280 | 0.6626 | -0.0347 |
| shieldCascade | 13 | 13 | 0.5556 | 0.5590 | -0.0034 |
| forcedDefense | 24 | 20 | 0.4697 | 0.4632 | 0.0065 |

The forced-defense cohort requires a currently exposed own king and at least one legal survival among otherwise losing replies. Dedicated-laser rows require one laser to be permanently assigned to exactly one king. Cascade rows measure newly exposed kings after the current shield contacts are removed.

## Runtime

- Cold extraction: 66.9 microseconds/position over 240 positions.
- Cache-warmed extraction: 1.9 microseconds/position.
- Candidate payload scale: 300 evaluation points per log-odds unit, clamped below mate scores.

## Gates

- noLeakage: **pass**
- symmetry: **pass**
- monotonic: **pass**
- testMeanImprovement: **pass**
- testConfidence: **fail**
- dedicatedCoverage: **fail**
- rareTestCoverage: **fail**

**Decision: candidate is arena-ready for diagnosis but did not clear every offline promotion gate; do not promote it to production yet.**
