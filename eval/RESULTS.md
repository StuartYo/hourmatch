# Evaluation results

All companies and plants are fictional; generation curves are real Taipower open data. Ground truth comes from `src/checker.mjs` applied to hand-written gold fields, never from a model.

- **HourMatch**: the model turns the sentence into fields; ledger code computes the share and the verdict.
- **Model alone**: the same model gets the claim, the full hourly table for that company (use and certificates per hour per plant), plant ages, and the exact matching rules in its prompt. No tools.

| Set | Setup | Correct verdicts | Share within 1 point |
|---|---|---|---|
| dev (18 claims) | HourMatch | 17 / 18 | 17 / 18 |
| dev | Model alone | 13 / 18 | 5 / 18 |
| holdout (8 claims) | HourMatch | 8 / 8 | 8 / 8 |
| holdout | Model alone | 3 / 8 | 1 / 8 |

Model: `aisingapore/Qwen-SEA-LION-v4-32B-IT` (PublicAI free inference, temperature 0). Run: 2026-10-14.

## dev

| id | truth | true share | HourMatch | model alone (share) |
|---|---|---|---|---|
| D01 | NOT_SUPPORTED | 83.03 | NOT_SUPPORTED (83.03) | NOT_SUPPORTED (99.5) |
| D02 | SUPPORTED | 103 | SUPPORTED (103) | NOT_SUPPORTED (99.5) |
| D03 | SUPPORTED | 83.03 | SUPPORTED (83.03) | SUPPORTED (83.4) |
| D04 | NOT_SUPPORTED | 83.03 | NOT_SUPPORTED (83.03) | NOT_SUPPORTED (94.5) |
| D05 | NOT_SUPPORTED | 82.84 | NOT_SUPPORTED (82.84) | NOT_SUPPORTED (99.9) |
| D06 | SUPPORTED | 100 | SUPPORTED (100) | NOT_SUPPORTED (99.5) |
| D07 | NOT_SUPPORTED | 65.38 | NOT_SUPPORTED (65.38) | NOT_SUPPORTED (0) |
| D08 | NOT_SUPPORTED | 74.7 | NOT_SUPPORTED (75.65) | NOT_SUPPORTED (99.5) |
| D09 | NOT_SUPPORTED | 81.93 | NOT_SUPPORTED (81.93) | NOT_SUPPORTED (99.5) |
| D10 | NOT_SUPPORTED | 81.93 | NOT_SUPPORTED (81.93) | NOT_SUPPORTED (99.5) |
| D11 | SUPPORTED | 104.99 | SUPPORTED (104.99) | NOT_SUPPORTED (100) |
| D12 | NOT_SUPPORTED | 89.23 | NOT_SUPPORTED (89.23) | NOT_SUPPORTED (100) |
| D13 | SUPPORTED | 90.55 | SUPPORTED (90.55) | NOT_SUPPORTED (89.5) |
| D14 | NOT_SUPPORTED | 83.28 | NOT_SUPPORTED (83.28) | NOT_SUPPORTED (99.5) |
| D15 | SUPPORTED | 81.48 | SUPPORTED (81.48) | SUPPORTED (81.5) |
| D16 | NOT_SUPPORTED | 90.55 | NOT_SUPPORTED (90.55) | NOT_SUPPORTED (99.5) |
| D17 | SUPPORTED | 79.38 | NOT_SUPPORTED (74.7) | SUPPORTED (79.3) |
| D18 | SUPPORTED | 83.03 | SUPPORTED (83.03) | NOT_SUPPORTED (82.5) |

## holdout

| id | truth | true share | HourMatch | model alone (share) |
|---|---|---|---|---|
| H01 | NOT_SUPPORTED | 65.44 | NOT_SUPPORTED (65.44) | NOT_SUPPORTED (99.5) |
| H02 | SUPPORTED | 103 | SUPPORTED (103) | NOT_SUPPORTED (100) |
| H03 | SUPPORTED | 100 | SUPPORTED (100) | NOT_SUPPORTED (100) |
| H04 | NOT_SUPPORTED | 71.65 | NOT_SUPPORTED (71.65) | NOT_SUPPORTED (99.5) |
| H05 | NOT_SUPPORTED | 105.01 | NOT_SUPPORTED (105.01) | NOT_SUPPORTED (100) |
| H06 | SUPPORTED | 86.71 | SUPPORTED (86.71) | NOT_SUPPORTED (85.5) |
| H07 | NOT_SUPPORTED | 40.06 | NOT_SUPPORTED (40.06) | SUPPORTED (48.5) |
| H08 | SUPPORTED | 103.99 | SUPPORTED (103.99) | NOT_SUPPORTED (100) |
