# Tuning matrix

Started 2026-10-10 12:53, 24.0 hours planned.

## Stage 2: learning-solver parameters

**Strategy 1**: 41 candidates on 89 tuning puzzles. Validation on 6 new puzzles: default 3 G (6 solved), best 3 G (6 solved) with `{'NONO_REDUCE_FIRST': 1000, 'NONO_TIERS': 1, 'NONO_VIVIFY_EVERY': 4000}` -> **adopted**.

**Strategy 0**: 105 candidates on 21 tuning puzzles. Validation on 8 new puzzles: default 46 G (8 solved), best 28 G (8 solved) with `{'NONO_DECAY': 0.9, 'NONO_KEEP_LBD': 3, 'NONO_POISON': 2, 'NONO_RESTART_UNIT': 200, 'NONO_SHRINK': 1, 'NONO_TIERS': 1, 'NONO_VIVIFY': 200}` -> **adopted**.

## Stage 1: portfolio

67 configurations screened; finalists on the validation puzzles (score below 1 is faster than the default):

- 0.982: threads 8, `{'NONO_CACHE_BITS': 14, 'NONO_CDCL_THREADS': 2, 'NONO_DECAY_S0': 0.9, 'NONO_KEEP_LBD_S0': 3, 'NONO_KEEP_THREADS': 2, 'NONO_PIN': 0, 'NONO_POISON_S0': 2, 'NONO_REDUCE_FIRST_S1': 1000, 'NONO_RESTART_UNIT_S0': 200, 'NONO_RETIRE_MS': 3000, 'NONO_SCORE': 3, 'NONO_SEEDS': '1,0,3,5,7,9', 'NONO_SHARE': 1, 'NONO_SHRINK_S0': 1, 'NONO_SOLO_US': 2000, 'NONO_TIERS_S0': 1, 'NONO_TIERS_S1': 1, 'NONO_VIVIFY_EVERY_S1': 4000, 'NONO_VIVIFY_S0': 200}`
- 0.986: threads 8, `{'NONO_CACHE_BITS': 12, 'NONO_CDCL_THREADS': 4, 'NONO_DECAY_S0': 0.9, 'NONO_KEEP_LBD_S0': 3, 'NONO_KEEP_THREADS': 2, 'NONO_PIN': 0, 'NONO_POISON_S0': 2, 'NONO_REDUCE_FIRST_S1': 1000, 'NONO_RESTART_UNIT_S0': 200, 'NONO_RETIRE_MS': 6000, 'NONO_SCORE': 3, 'NONO_SEEDS': '0,1,3,5,7,9', 'NONO_SHARE': 1, 'NONO_SHRINK_S0': 1, 'NONO_SOLO_US': 500, 'NONO_TIERS_S0': 1, 'NONO_TIERS_S1': 1, 'NONO_VIVIFY_EVERY_S1': 4000, 'NONO_VIVIFY_S0': 200}`
- 1.001: threads 8, `{'NONO_CACHE_BITS': 14, 'NONO_CDCL_THREADS': 3, 'NONO_DECAY_S0': 0.9, 'NONO_KEEP_LBD_S0': 3, 'NONO_KEEP_THREADS': 3, 'NONO_PIN': 0, 'NONO_POISON_S0': 2, 'NONO_REDUCE_FIRST_S1': 1000, 'NONO_RESTART_UNIT_S0': 200, 'NONO_RETIRE_MS': 0, 'NONO_SCORE': 3, 'NONO_SEEDS': '1,0,3,5,7,9', 'NONO_SHARE': 1, 'NONO_SHRINK_S0': 1, 'NONO_SOLO_US': 2000, 'NONO_TIERS_S0': 1, 'NONO_TIERS_S1': 1, 'NONO_VIVIFY_EVERY_S1': 4000, 'NONO_VIVIFY_S0': 200}`
- 1.014: threads 6, `{'NONO_CACHE_BITS': 14, 'NONO_CDCL_THREADS': 4, 'NONO_DECAY_S0': 0.9, 'NONO_KEEP_LBD_S0': 3, 'NONO_KEEP_THREADS': 2, 'NONO_PIN': 0, 'NONO_POISON_S0': 2, 'NONO_REDUCE_FIRST_S1': 1000, 'NONO_RESTART_UNIT_S0': 200, 'NONO_RETIRE_MS': 3000, 'NONO_SCORE': 3, 'NONO_SEEDS': '1,0,3,5', 'NONO_SHARE': 1, 'NONO_SHRINK_S0': 1, 'NONO_SOLO_US': 500, 'NONO_TIERS_S0': 1, 'NONO_TIERS_S1': 1, 'NONO_VIVIFY_EVERY_S1': 4000, 'NONO_VIVIFY_S0': 200}`
- 1.016: threads 7, `{'NONO_CACHE_BITS': 12, 'NONO_CDCL_THREADS': 4, 'NONO_DECAY_S0': 0.9, 'NONO_KEEP_LBD_S0': 3, 'NONO_KEEP_THREADS': 2, 'NONO_PIN': 0, 'NONO_POISON_S0': 2, 'NONO_REDUCE_FIRST_S1': 1000, 'NONO_RESTART_UNIT_S0': 200, 'NONO_RETIRE_MS': 15000, 'NONO_SCORE': 1, 'NONO_SEEDS': '0,1,3,5,7,9', 'NONO_SHARE': 1, 'NONO_SHRINK_S0': 1, 'NONO_SOLO_US': 2000, 'NONO_TIERS_S0': 1, 'NONO_TIERS_S1': 1, 'NONO_VIVIFY_EVERY_S1': 4000, 'NONO_VIVIFY_S0': 200}`
- 1.019: threads 8, `{'NONO_CACHE_BITS': 14, 'NONO_CDCL_THREADS': 3, 'NONO_DECAY_S0': 0.9, 'NONO_KEEP_LBD_S0': 3, 'NONO_KEEP_THREADS': 3, 'NONO_PIN': 0, 'NONO_POISON_S0': 2, 'NONO_REDUCE_FIRST_S1': 1000, 'NONO_RESTART_UNIT_S0': 200, 'NONO_RETIRE_MS': 15000, 'NONO_SCORE': 3, 'NONO_SEEDS': '1,3,5,7,9,11', 'NONO_SHARE': 1, 'NONO_SHRINK_S0': 1, 'NONO_SOLO_US': 8000, 'NONO_TIERS_S0': 1, 'NONO_TIERS_S1': 1, 'NONO_VIVIFY_EVERY_S1': 4000, 'NONO_VIVIFY_S0': 200}`
- 1.031: threads 7, `{'NONO_CACHE_BITS': 14, 'NONO_CDCL_THREADS': 4, 'NONO_DECAY_S0': 0.9, 'NONO_KEEP_LBD_S0': 3, 'NONO_KEEP_THREADS': 4, 'NONO_PIN': 0, 'NONO_POISON_S0': 2, 'NONO_REDUCE_FIRST_S1': 1000, 'NONO_RESTART_UNIT_S0': 200, 'NONO_RETIRE_MS': 3000, 'NONO_SCORE': 1, 'NONO_SEEDS': '1,0,3,5', 'NONO_SHARE': 1, 'NONO_SHRINK_S0': 1, 'NONO_SOLO_US': 500, 'NONO_TIERS_S0': 1, 'NONO_TIERS_S1': 1, 'NONO_VIVIFY_EVERY_S1': 4000, 'NONO_VIVIFY_S0': 200}`
- 1.035: threads 8, `{'NONO_CACHE_BITS': 12, 'NONO_CDCL_THREADS': 5, 'NONO_DECAY_S0': 0.9, 'NONO_KEEP_LBD_S0': 3, 'NONO_KEEP_THREADS': 5, 'NONO_PIN': 1, 'NONO_POISON_S0': 2, 'NONO_REDUCE_FIRST_S1': 1000, 'NONO_RESTART_UNIT_S0': 200, 'NONO_RETIRE_MS': 6000, 'NONO_SCORE': 1, 'NONO_SEEDS': '1,0,3,5,7,9', 'NONO_SHARE': 1, 'NONO_SHRINK_S0': 1, 'NONO_SOLO_US': 8000, 'NONO_TIERS_S0': 1, 'NONO_TIERS_S1': 1, 'NONO_VIVIFY_EVERY_S1': 4000, 'NONO_VIVIFY_S0': 200}`

Winner: score 1.000, threads 8, `{'NONO_DECAY_S0': 0.9, 'NONO_KEEP_LBD_S0': 3, 'NONO_POISON_S0': 2, 'NONO_REDUCE_FIRST_S1': 1000, 'NONO_RESTART_UNIT_S0': 200, 'NONO_SHRINK_S0': 1, 'NONO_TIERS_S0': 1, 'NONO_TIERS_S1': 1, 'NONO_VIVIFY_EVERY_S1': 4000, 'NONO_VIVIFY_S0': 200}`

## Stage 3: final comparison

| configuration | score vs current defaults | d40hi | d40lo | d50hi | d50lo | pic | r30 | r45 | r50 | r60 | survey |
|---|---|---|---|---|---|---|---|---|---|---|---|
| current defaults | 1.000 | 1.000 | 1.000 | 1.000 | 1.000 (7 unsolved) | 1.000 | 1.000 | 1.000 | 1.000 (1 unsolved) | 1.000 (4 unsolved) | 1.000 |
| default + stage 2 | 0.969 | 1.005 | 0.917 | 0.991 | 0.678 (5 unsolved) | 1.004 | 0.986 | 1.016 | 0.934 | 1.125 (4 unsolved) | 0.978 |

- current defaults: threads 8, `{}`
- default + stage 2: threads 8, `{'NONO_DECAY_S0': 0.9, 'NONO_KEEP_LBD_S0': 3, 'NONO_POISON_S0': 2, 'NONO_REDUCE_FIRST_S1': 1000, 'NONO_RESTART_UNIT_S0': 200, 'NONO_SHRINK_S0': 1, 'NONO_TIERS_S0': 1, 'NONO_TIERS_S1': 1, 'NONO_VIVIFY_EVERY_S1': 4000, 'NONO_VIVIFY_S0': 200}`

Knotty and Faase (seconds, two runs each):

- current defaults: 23.1, 22.8, 124.8, 125.0
- default + stage 2: timeout, timeout, timeout, 263.8

## Checks

Puzzles where two runs disagreed on unique or multiple (a bug if not empty): none.
Runs measured while another job used the machine: 0.
