# Benchmark results

Measured on 2026-10-09 at commit 42b710f. Raw data is in [data/](data/), the scripts that made
it in this directory (`run.py`, `sat.py`, `plot.py`; `../tune/hard.py` for the medians).

## Method

- **Machine:** Intel Core Ultra 7 258V (4 performance and 4 low-power cores), NixOS, "balanced"
  power profile, an otherwise idle machine (the load average of 1-3 came from the runs
  themselves). Every solver checks uniqueness: it reports one solution or at least two.
- **Hugi:** a plain `cargo build --release` (PGO numbers are marked), all 8 cores, wall time of the
  whole process. The parallel search is nondeterministic, so the table gives the median of 15
  interleaved runs with the 10th-90th percentile (`tune/hard.py`); 3 runs for Knotty and Faase.
- **Rivals:** single-threaded (none of them can use more), pinned to one performance core, built
  with `-O3 -march=native`, 60 s limit, one run each:
  kissat 4.0.4 and CaDiCaL 3.0.1 on Hugi's CNF encoding (`hugi cnf`; two runs, the second with a
  clause that forbids the first solution, for the uniqueness check; encoding time not counted),
  Naughty v88 (Wu), pbnsolve 1.10 (Wolter), nonogrid 0.7.3 (tsionyx), Olšák's grid 1.2 (built with
  `-std=gnu89`, buffer and block limits raised from 100/30 to 1024/64 because Gettys exceeded
  them, run with `-total 2`), and Copris 2.0 (Scala 2.12.18, Java start-up included, with kissat
  as its SAT backend, its fastest setup here).
- **Which encoding:** kissat and CaDiCaL are measured on the *lean* encoding that Hugi's own
  learning solver uses. It is up to 4.5 times faster for them than the older encoding with
  auxiliary cover variables (`data/sat-2026-10-08.tsv` has the older numbers: Gettys 13.7 s,
  Knotty 427 s, Faase 424 s), so the rivals are measured at their best.

## The nine hard puzzles of the survey

| puzzle | Hugi plain [10th-90th] | Hugi PGO | kissat | CaDiCaL | best rival / Hugi |
|---|---|---|---|---|---|
| 2712 Lion | 49 ms [40-66] | 41 ms | 359 ms | 718 ms | 7.3× |
| 6574 Forever | 12 ms [11-15] | 11 ms | 43 ms | 9 ms | 0.75× |
| 8098 9-Dom | 55 ms [52-58] | 53 ms | 40 ms | 44 ms | 0.73× |
| 9892 Nature | 167 ms [92-309] | 132 ms | 694 ms | 1.07 s | 4.2× |
| 10088 Marley | 37 ms [32-54] | 34 ms | 344 ms | 825 ms | 9.3× |
| 10810 Center | 9 ms [8-10] | 9 ms | 55 ms | 37 ms | 4.1× |
| 12548 Sierp | 180 ms [105-202] | 173 ms | 1.41 s | 1.52 s | 7.8× |
| 18297 Thing | 729 ms [419-1105] | 756 ms | 1.23 s | 1.41 s | 1.7× |
| 22336 Gettys | 1.98 s [1.88-4.40] | 1.83 s | 4.27 s | 4.90 s | 2.2× |

Geometric mean of the last column: 3.0. Hugi is first on seven, behind on 9-Dom and Forever;
Forever differs by 3 ms, and Hugi's time includes process start-up where the rivals' does not.
The other 19 puzzles of the survey take 2-13 ms for every solver, so process start-up dominates
(`data/results-2026-10-09-final-ours.tsv` has Hugi on all 28).

### The other solvers on the same puzzles

| puzzle | Hugi | Naughty | pbnsolve | nonogrid | Copris + kissat | grid |
|---|---|---|---|---|---|---|
| Lion | **49 ms** | 14.7 s | 1.57 s | 261 ms | 3.58 s | > 60 s |
| Forever | **12 ms** | 90 ms | 818 ms | 1.56 s | 1.99 s | 1.01 s |
| 9-Dom | **55 ms** | 4.65 s | 2.61 s | 5.44 s | 1.12 s | > 60 s |
| Nature | **167 ms** | 26.3 s | > 60 s | 34.4 s | 3.93 s | > 60 s |
| Marley | **37 ms** | 13.2 s | > 60 s | 136 ms | 5.35 s | > 60 s |
| Center | **9 ms** | 1.06 s | 1.78 s | 67 ms | 6.33 s | 13 ms |
| Sierp | **180 ms** | > 60 s | > 60 s | > 60 s | 10.2 s | > 60 s |
| Thing | **729 ms** | > 60 s | > 60 s | > 60 s | 8.24 s | > 60 s |
| Gettys | **1.98 s** | too big | > 60 s | > 60 s | 41.1 s | > 60 s |

Copris solves all 28 survey puzzles (0.7-6 s on the easy ones, mostly Java start-up); grid solves
the easy ones in 1-13 ms and times out on nine. These columns were measured on 2026-10-08/09
(`data/results-2026-10-08.tsv`, `data/results-2026-10-09-grid*.tsv`).

## The puzzles no solver finished

Knotty and Faase are the two puzzles of Wolter's survey (2009-2013) that no solver finished within
30 minutes (the third, Meow, is gone from webpbn). Fetch them with `scripts/fetch-unsolved.sh`.
Both have at least two solutions; the printed solutions satisfy every clue (checked by an
independent script) and kissat reports two solutions as well.

| puzzle | Hugi, 8 cores | kissat, 1 core | survey |
|---|---|---|---|
| Knotty, 40×40 ("Knotty Puzzle", Joe Cooke) | **20.2 s** (18.9-22.3); PGO 19.1 s | 166 s | none in 30 min |
| Faase, 80×95 ("Faase", Kerrin Mansfield) | 121.4 s (121.4-122.9); PGO 97.7 s | 114 s | none in 30 min |

## Random puzzles

- **The survey's 5 000 random 30×30 puzzles** (`rand30.tgz` from the survey page, converted from
  pictures to clues): all solved, 26.3 s in total, geometric mean 2.4 ms, slowest 1.4 s; 4 876
  have several solutions, 124 are unique (`data/random-rand30-2026-10-09.tsv`).
- **20 random 50×50 and 60×60 puzzles at 50 % density** (`hugi gen 50 50 50 6000` and so on,
  seeds 6000-6011 and 7000-7007), per process:

  | | total time | solved |
  |---|---|---|
  | kissat, 1 core | 43.6 s (none above 9.1 s) | 20/20 |
  | Hugi portfolio, 8 cores | about 45 s (38-58 s, depending on the machine's load) | 20/20 |
  | Hugi's learning solver with block-position variables, 1 core | 31.0 s (PGO 30.5 s) | 20/20 |

  On one core Hugi's best engine is faster than kissat on 17 of the 20; kissat is ahead on
  r50x50-6011, r60x60-7001 and r60x60-7004. The eight cores do not help on this class: the
  portfolio needs more time than its own best engine on one core. The 3 s retirement of the
  extra learning threads is a trade: without it the set takes 36 s, but Faase 160 s
  (see [../docs/experiments.md](../docs/experiments.md)). Data: `data/equal-cores-2026-10-09.tsv`,
  `data/portfolio-*-2026-10-09.txt`.
- **The frontier: 12 random 70×70 and 99×99 puzzles**, 60 s: kissat solves 4 (3.2, 35, 54 and
  50 s), Hugi 2 (2.2 s and 40 s). That size is hard for every solver we tried.

## Notes

- With all its inprocessing switched off, kissat still solves the hardest of the 50×50 and 60×60
  puzzles in 8-10 s, and plain MiniSat does not (r50x50-6004 over 60 s, r60x60-7002 54 s): its
  strength on random puzzles is the modern search core as a whole, not one technique.

## More solvers, 2026-10-10

Constraint-programming and answer-set solvers, and the nearest open-source nonogram tool, on the
same machine, one run each, 60 s limit (300 s for Knotty and Faase). The scripts are
`compare/cp.py` and the notes below; raw data in `data/cp-rivals-2026-10-09.tsv` and
`data/number-loom-2026-10-09.tsv`.

- **CP-SAT** (OR-tools 9.15) with one automaton constraint per line, on one core (`cpsat1`) and
  with 8 workers (`cpsat`). The 8-worker runs went on while other jobs kept the load average at
  5-8, so they are no better than the one-worker runs.
- **Chuffed 0.14** (lazy clause generation, the same family as Hugi's learning solver) through
  MiniZinc 2.10, free search. Two models: one `regular` constraint per line, and block start
  positions as integer variables, "chuffed-pos", which is far better and used below.
  **Gecode 6.4** with the `regular` model solves only Forever, 9-Dom and Center within 60 s.
- **clingo 5.8** (answer-set programming), one thread, a block-start encoding, two models asked
  for (a second model means several solutions).
- **Number Loom** (paulstansifer/number-loom, commit 47d7cb5, 0.6.0, MIT): `number-loom puzzle.g
  --backtrack`, whole-process time on one core. Its backtracking solver learns which combinations
  are impossible. "Solved" means a unique solution; "unable to solve, N cells left" means
  several, and it only stops after finding which cells differ in all of them, which is more
  work than Hugi's "at least two". It is built for editing (colours, trianograms, triddlers), not
  for speed.
- The solver-only times of the first four leave out model building, flattening, grounding and
  start-up, as for kissat above; Number Loom's and Hugi's are whole-process times.

| puzzle | Hugi | kissat | CP-SAT, 1 core | CP-SAT, 8 workers | Chuffed | clingo | Number Loom |
|---|---|---|---|---|---|---|---|
| Lion | **49 ms** | 359 ms | 2.02 s | 2.27 s | 4.65 s | 1.60 s | > 60 s |
| Forever | 12 ms | 43 ms | 70 ms | 80 ms | 8 ms | 10 ms | 170 ms |
| 9-Dom | 55 ms | 40 ms | 340 ms | 220 ms | 100 ms | 90 ms | 1.36 s |
| Nature | **167 ms** | 694 ms | 3.69 s | 3.92 s | > 60 s | 51.4 s | 49.1 s |
| Marley | **37 ms** | 344 ms | 8.48 s | 10.25 s | 40.9 s | 20.2 s | 34.2 s |
| Center | **9 ms** | 55 ms | 410 ms | 740 ms | 30 ms | 2.20 s | 90 ms |
| Sierp | **180 ms** | 1.41 s | 4.41 s | 7.39 s | > 60 s | > 60 s | > 60 s |
| Thing | **729 ms** | 1.23 s | 8.11 s | 10.26 s | > 60 s | 46.4 s | > 60 s |
| Gettys | **1.98 s** | 4.27 s | 20.5 s | 33.8 s | > 60 s | > 60 s | > 60 s |

On the tiny puzzles the solver-only times of Chuffed and clingo (8-10 ms on Forever) match
CaDiCaL's 9 ms; their whole-process times are 450 ms and 26 ms, against Hugi's 12 ms.

| set, 60 s per puzzle | solved |
|---|---|
| 20 random 50×50 and 60×60 | Hugi 20, kissat 20, CP-SAT (1 core) 18, CP-SAT (8 workers) 17, clingo 12, Chuffed 10, Number Loom 3 |
| 12 random 70×70 and 99×99 | kissat 4, Hugi 2, CP-SAT with 8 workers 1 (24 s), clingo 0 |
| Knotty and Faase, 300 s | Hugi 2, kissat 2 (166 s and 114 s), CP-SAT 0, clingo 0, Number Loom 0 |

CP-SAT is the strongest of these: 3 to 25 times slower than kissat and 10 to 230 times slower than
Hugi on the survey puzzles it solves. Chuffed uses the same technique as Hugi's learning solver
(lazy clause generation), but through the generic start-position model it solves 5 of the 9 survey
puzzles (none of Nature, Sierp, Thing and Gettys) and 10 of the 20 random ones. The difference is
probably the exact line solver as the propagator, with explanations built on demand; that is a
guess, not a measurement.
