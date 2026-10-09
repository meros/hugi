# Experiments

Every change to Hugi was measured, and kept only if it won. This page records what was tried,
what the numbers were and what was decided, including the many things that did not pay off.
Most of them are still in the code as `NONO_*` environment variables, so a result can be
checked again (`src/solver.rs`, `src/cdcl.rs`).

Decisions: **kept** (a default), **setting** (in the code, off by default), **dropped** (removed).

## How the numbers were made

- **Wall-time comparisons** use `tune/hard.py`: each configuration runs each puzzle 10-15 times,
  interleaved round-robin with the other configurations, and the report is the median with the
  10th-90th percentile. The parallel search is nondeterministic, so single runs mislead (Nature
  ranged 33-258 ms best of 3 under one configuration).
- **Learning-solver comparisons** use `tune/cdcl_ab.py` with a budget of retired instructions
  (`INSTR=1`, counted with `perf`) or of conflicts: one thread is deterministic, so the result
  does not depend on what else the machine is doing. Changes that make a conflict cheaper but
  change the search are judged on the instructions needed to solve a set of 72 random puzzles
  (40×40 to 60×60), and checked on a hold-out set of 48 puzzles that were not used for tuning.
- **PAR-2** counts an unsolved puzzle as twice the time limit.
- Machine: Intel Core Ultra 7 258V (4 performance and 4 low-power cores), NixOS.

## Learning solver

| Experiment | Result | Decision |
|---|---|---|
| Target phases (decisions follow the longest conflict-free assignment seen) | Gettys 18 s → 4.2 s | kept (strategy 0) |
| Stable/focused mode switching and rephasing | no measurable gain in the portfolio | setting (`NONO_MODES`, `NONO_REPHASE`) |
| Explanations by feasibility checks (QuickXplain) and an explanation cache | 3.5× faster analysis; Gettys had spent 87 % of its time explaining | kept |
| Explanations limited to a window around the forced cell (`NONO_WINDOW`) | Thing 2.8× faster, Gettys 6× slower | setting |
| Recursive clause minimisation | shorter clauses | kept |
| Block-position variables with the order encoding (strategy 1) | random puzzles need them; also fastest on Nature, 9-Dom, Thing, Gettys | kept |
| **Lean encoding**: no auxiliary cover variables (`src/cnf.rs`) | the cover variables were 862 of 1 723 propagations per conflict; 42 % fewer instructions per conflict; on 72 puzzles with a 60 G-instruction budget 71/72 solved against 68/72 (PAR-2 620 against 1 156 G); kissat is faster on it as well (5 s against 7 s on a 50×50) | kept, also for `hugi cnf` |
| Shrinking (all-UIP minimisation), decay 0.90, vivification of 400 clauses per round | 62/72 → 67/72 solved, PAR-2 3.00 M → 1.81 M conflicts; on strategy 0 the same settings made Gettys 3.4× slower | kept (strategies 1 and 2) |
| Linear-cost clause minimisation (depth-first, every result recorded, as in CaDiCaL) | analysis per conflict 2-4× cheaper (123 → 28 µs on a 50×50); 67/72 → 69/72 solved; strategy 0 mixed (Thing 2.3× faster, Gettys 2× slower) | kept (strategies 1 and 2) |
| Re-tune after the lean encoding: decay 0.85, vivification of 200 clauses | tuning set 72/72 against 71/72 (PAR-2 477 against 629 G); hold-out 44/48 and 43/48 against 43/48 and 42/48 with two seeds | kept |
| Clearing only the explanations that exist when backtracking | 2-3 % fewer instructions, same search | kept |
| Glucose restarts for strategy 1 | better on the tuning set (PAR-2 416 against 477 G), level on the hold-out set | dropped |
| Mode switching or warm-up for strategy 1 | 70/72 each against 72/72 | dropped |
| Binary-first propagation | fewer conflicts but 13-20 % more instructions per conflict; 70/72 against 72/72 | dropped |
| Binary reasons that never touch the clause store | 67/72 against 69/72 | dropped |
| Clause tiers, reason-side bumping, decay 0.85 on top of shrinking (before the re-tune) | small or mixed | setting (`NONO_TIERS`, `NONO_REASON_BUMP`) |
| Clause sharing between learning threads (`NONO_SHARE_CLAUSES`) | worse on the hard random set in 3 of 4 runs; with the first thread importing, Gettys 2.5× slower | setting |
| Root probing inside the learning solver (`NONO_ROOTPROBE`) | Lion 29× faster, Gettys 2.6× slower for the learning solver alone; no portfolio gain | setting |
| **Ladder propagator** (`NONO_LADDER`): chain and ordering clauses applied directly, no watch-list scans | 6-16 % fewer instructions per conflict, but 70/72 and 69/72 solved against 71/72 on two seeds | setting |
| **Bounds mode** (`NONO_BOUNDS`): no cell clauses; the line propagator works on cells and block-start bounds (`line::solve_bounds`) | stronger propagation (Sierp 9 746 against 24 384 conflicts) but about 25 line explanations per conflict at ~15 µs; 34/72 against 71/72 | setting |
| Strategy 1 without the line solver, clauses only (`NONO_S1_NOLINES`) | 28 % cheaper per conflict but needs 1.75× the conflicts; 63/72 against 69/72 | setting |
| Diverse settings across the extra seeds (`NONO_DIVERSE`) | inconclusive | setting |

## Probing search

| Experiment | Result | Decision |
|---|---|---|
| Skip probes that cannot have changed (exact, carried from parent to child) | one thread 1.2-2.8× faster, same search tree (Nature 2.8×, Thing 1.5×) | kept |
| Line cache size | 2^14 entries best (Sierp 7.06 G cycles; 2^12: 8.08, 2^16: 7.34) | kept |
| Compact 32-byte cache entries for lines up to 61 cells | last-level cache misses halved, but 13-15 % more cycles: those misses were about 0.5 % of cycles | dropped |
| Preselection (as in march): skip re-probing cells scored below 1/K of the best | only 2-5 % of probes fail, but with K = 4-16 Sierp and Thing no longer finished in 120 s: the failing probes among the skipped cells keep the tree small | dropped |
| Global row/column count check by max-flow (`src/flow.rs`, `NONO_FLOW`) | nothing found on Thing, Nature, random 50×50; Sierp 1.27× | setting |
| Profile-guided build (`scripts/build-pgo.sh`) | learning solver 1.36×, probing search up to 1.1×; Faase 121 s → 98 s | kept (opt-in build) |

## Portfolio

| Experiment | Result | Decision |
|---|---|---|
| Share cells proven in every solution between the engines | hard random set PAR-2 about -10 %; the cells-only learning solver must not import them (Gettys became erratic) | kept |
| Four learning threads from the start (strategies 1, 0, 3, 5; 3 and 5 retire after 3 s) | survey geometric mean 94.8 against 104.9 ms (9-Dom 58 against 82 ms, Gettys 2.5 against 4.0 s, Thing 610 against 503 ms); Knotty and Faase level; without retiring, Faase took 160-229 s because more busy cores lower the clock | kept |
| Retirement time of the extra threads | hard random set per process 45 s (3 s), 42 s (10 s), 39 s (30 s), 36 s (never); Knotty 20 / 25 / 28 s; Faase 121 / 127 / 132 / 160 s: a smooth trade | 3 s kept |
| Engines run detached and the portfolio returns at the first winner | with strategy 1 started at once, Center had gone from 8 to 41 ms (the time strategy 1 needs to build its encoding) | kept |
| Pin the first learning thread to a performance core (`NONO_PIN`) | first look 15-35 % better, interleaved 3 rounds: slower, the first look was noise | setting |
| Why the 8-core portfolio needs more time than its best engine on one core | default, no fact sharing, strategy 1 plus 7 probing threads, two learning threads: all within the noise except the third (worse) | no change |
| Fewer probing threads next to the four learning threads (`--threads 6`, `--threads 5`) | hard random set per process, 3 interleaved rounds as the machine's load rose from 3 to 7: 8 threads 47 / 58 / 53 s, 6 threads 42 / 54 / 57 s, 5 threads 46 / 56 / 50 s: no difference beyond the noise | no change |
| Cube-and-conquer: below a depth the probing search hands its partial grid to a learning solver (`NONO_CUBE_DEPTH`) | alone it solves a 60×60 the portfolio does not (34 s) but loses on others; in the portfolio 17/20 against 15/20 | setting |
| A cube arm on idle cores (`NONO_CUBE_ARM`) | 33/40 against 32/40, within the noise | setting |

## Reference points

Measured 2026-10-08 on one performance core, before the lean encoding: kissat 4.0.4 on Gettys
18.8 s, CaDiCaL 3.0.1 34.8 s; Hugi's learning solver alone 47 s, the portfolio 84-107 s. The final
comparison with the same solvers on the lean encoding is in
[compare/RESULTS.md](../compare/RESULTS.md).

## Open ideas

- **Explanations from the line's dynamic-programming graph** (Gange & Stuckey), cheaper than
  asking the line solver dozens of questions per forced cell. Bounds mode would need it first.
- **A portfolio that uses its cores on random puzzles.** The best single engine on one core needs
  31 s on the 20 hard random puzzles; the 8-core portfolio needs about 40 s.
- **Bounded variable elimination** of block-position variables (kissat removes 30 % of the
  variables of the same encoding), which is hard to combine with the line propagator.
- Colour puzzles; the 70×70 and 99×99 random tier, where kissat solves 4 of 12 and Hugi 2.

## Reading list

Papers and code that shaped these experiments:

- Biere & Fleury, "Chasing target phases", https://fmv.jku.at/chasing-target-phases
- Huang et al., ICGA Journal 2018 (probing for nonograms), https://content.iospress.com/articles/icga-journal/icg180069
- Chen & Huang, ICGA Journal 2018 (probing and SAT together), https://content.iospress.com/articles/icga-journal/icg180067
- Gange & Stuckey, "Explaining propagators for s-DNNF circuits", https://people.eng.unimelb.edu.au/pstuckey/papers/sdnnf.pdf
- Li et al., "Clause vivification by unit propagation", https://arxiv.org/pdf/1807.11061
- Hickey & Bacchus, "Trail saving on backtrack", https://pmc.ncbi.nlm.nih.gov/articles/PMC7326469
- Heule et al., "Cube and conquer" (2011)
- Fleury & Biere, "Efficient all-UIP learned clause minimization" (SAT 2021)
- Metodi, Codish et al., "Compiling finite domain constraints to SAT with BEE", https://arxiv.org/pdf/1104.4617
- Liang et al., "Learning rate based branching heuristic for SAT solvers", https://cs.uwaterloo.ca/~ppoupart/publications/sat/learning-rate-branching-heuristic-SAT.pdf
- Jan Wolter, survey of paint-by-number solvers, https://webpbn.com/survey/
