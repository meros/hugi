//! Hugi: a fast nonogram solver. Hugi ("thought") is the runner in the
//! Prose Edda whom no one could outrun.
//!
//!     hugi <puzzle.txt> [--threads N] [--bench RUNS]
//!     hugi gen <width> <height> <density%> <seed>
//!     hugi bench <width> <height> <density%> <count> <seed> [--threads N]
//!     hugi batch <list-of-files> [--limit-ms N] [--threads N]

// Index loops over parallel per-line arrays read more clearly than iterator chains here.
#![allow(clippy::needless_range_loop)]

use hugi::cdcl;
use hugi::format::*;
use hugi::solver::{self, Outcome, Puzzle};
use std::time::Instant;

fn render(p: &Puzzle, o: &Outcome) -> String {
    let Some(g) = o.solutions.first() else { return "no solution\n".into() };
    let mut s = String::new();
    for r in 0..p.h {
        for c in 0..p.w {
            s += if g.filled(r, c) { "██" } else { "··" };
        }
        s += "\n";
    }
    s += if o.solutions.len() == 1 { "unique solution\n" } else { "NOT unique: at least two solutions\n" };
    s
}

fn flag(args: &[String], name: &str) -> Option<u64> {
    let i = args.iter().position(|a| a == name)?;
    args.get(i + 1)?.parse().ok()
}

fn num(args: &[String], i: usize, what: &str) -> u64 {
    args.get(i).and_then(|x| x.parse().ok()).unwrap_or_else(|| die(&format!("missing or bad {what}")))
}

fn die(msg: &str) -> ! {
    eprintln!("hugi: {msg}");
    std::process::exit(2);
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let threads = flag(&args, "--threads").unwrap_or(0) as usize;
    match args.first().map(String::as_str) {
        None => die("usage: hugi <puzzle.txt> [--threads N] [--bench RUNS] | gen W H DENSITY SEED | bench W H DENSITY COUNT SEED"),
        Some("gen") => {
            let (rows, cols) = generate(num(&args, 1, "width") as usize, num(&args, 2, "height") as usize, num(&args, 3, "density"), num(&args, 4, "seed"));
            print!("{}", to_text(&rows, &cols));
        }
        Some("batch") => {
            // One process for the whole list, so start-up is not timed; a
            // limit per puzzle; one result line per puzzle, then PAR-2 (total
            // time with each timeout counted at twice the limit).
            let list = args.get(1).unwrap_or_else(|| die("batch needs a file listing puzzle paths"));
            let limit = flag(&args, "--limit-ms").unwrap_or(10_000);
            let files: Vec<String> = std::fs::read_to_string(list).unwrap_or_else(|e| die(&format!("{list}: {e}")))
                .lines().map(str::trim).filter(|l| !l.is_empty()).map(String::from).collect();
            eprintln!("config {:?}", solver::config());
            let (mut par2, mut solved, mut log_sum) = (0f64, 0usize, 0f64);
            for f in &files {
                let text = std::fs::read_to_string(f).unwrap_or_else(|e| die(&format!("{f}: {e}")));
                let p = parse(&text).unwrap_or_else(|e| die(&format!("{f}: {e}")));
                let t = Instant::now();
                let o = solver::solve_within(&p, threads, Some(std::time::Duration::from_millis(limit)));
                let ms = t.elapsed().as_secs_f64() * 1e3;
                let status = if o.timed_out { "timeout" } else if o.solutions.len() == 1 { "unique" } else if o.solutions.is_empty() { "none" } else { "multiple" };
                let cost = if o.timed_out { 2.0 * limit as f64 } else { ms };
                par2 += cost;
                solved += !o.timed_out as usize;
                log_sum += (cost + 0.01).ln();
                println!("{f}\t{ms:.3}\t{}\t{status}", o.nodes);
                solver::quiesce(); // not timed: the next puzzle starts on idle cores
            }
            println!("# solved {solved}/{} par2 {:.1} ms geomean {:.4} ms", files.len(), par2, (log_sum / files.len() as f64).exp());
        }
        Some("cnf") => {
            // The puzzle as CNF (DIMACS) for an external SAT solver: the
            // reference the learning solver is measured against. Cells are
            // variables 1..=h*w, row-major.
            let path = args.get(1).unwrap_or_else(|| die("cnf needs a puzzle file"));
            let text = std::fs::read_to_string(path).unwrap_or_else(|e| die(&format!("{path}: {e}")));
            let (rows, cols) = parse_clues(&text).unwrap_or_else(|e| die(&format!("{path}: {e}")));
            print!("{}", to_cnf(&rows, &cols));
        }
        Some("bench") => {
            let (w, h, d, n, seed) = (num(&args, 1, "width") as usize, num(&args, 2, "height") as usize, num(&args, 3, "density"), num(&args, 4, "count"), num(&args, 5, "seed"));
            let puzzles: Vec<Puzzle> = (0..n).map(|i| {
                let (r, c) = generate(w, h, d, seed + i);
                Puzzle::new(&r, &c)
            }).collect();
            let t = Instant::now();
            let (mut unique, mut multi, mut nodes, mut worst, mut par) = (0, 0, 0, 0f64, 0);
            for p in &puzzles {
                let t1 = Instant::now();
                let o = solver::solve(p, threads);
                worst = worst.max(t1.elapsed().as_secs_f64());
                nodes += o.nodes;
                par += (o.threads_used > 1) as u32;
                match o.solutions.len() {
                    1 => unique += 1,
                    2 => multi += 1,
                    _ => die("a generated puzzle had no solution: solver bug"),
                }
            }
            let total = t.elapsed().as_secs_f64();
            println!("{n} random {w}×{h} at {d}%: {unique} unique, {multi} with several solutions, {nodes} search nodes, {par} went parallel");
            println!("total {:.3} s, {:.1} µs per puzzle, slowest {:.1} ms", total, total / n as f64 * 1e6, worst * 1e3);
        }
        Some(path) => {
            let text = std::fs::read_to_string(path).unwrap_or_else(|e| die(&format!("{path}: {e}")));
            let p = parse(&text).unwrap_or_else(|e| die(&format!("{path}: {e}")));
            if args.iter().any(|a| a == "--json") {
                let t = Instant::now();
                let o = solver::solve(&p, threads);
                println!("{}", to_json(&p, &o, t.elapsed().as_secs_f64()));
                return;
            }
            let t = Instant::now();
            if args.iter().any(|a| a == "--cdcl") {
                let seed = std::env::var("NONO_SEED").ok().and_then(|v| v.parse().ok()).unwrap_or(0);
                let c = cdcl::solve(&p, None, None, None, seed, None);
                let once = t.elapsed();
                if c.timed_out {
                    println!("timed out");
                }
                let o = solver::Outcome { solutions: c.solutions, timed_out: c.timed_out, nodes: c.stats.decisions, threads_used: 1, ..Default::default() };
                print!("{}", render(&p, &o));
                let st = &c.stats;
                println!("{}×{}, cdcl: {} conflicts, {} decisions, {} propagations, {} explanations, {} restarts, {:.1} µs",
                    p.h, p.w, st.conflicts, st.decisions, st.propagations, st.explanations, st.restarts, once.as_secs_f64() * 1e6);
                let ms = |ns: u64| ns as f64 / 1e6;
                println!("  first solution {:.1} ms; propagation {:.1} ms; analysis {:.1} ms (explanations {:.1} ms, cache hits {:.1} %); avg learned clause {:.1} literals",
                    ms(st.first_solution_ns), ms(st.propagate_ns), ms(st.analyze_ns), ms(st.explain_ns),
                    100.0 * st.explain_hits as f64 / st.explanations.max(1) as f64,
                    st.learnt_lits as f64 / st.conflicts.max(1) as f64);
                if st.shrunk + st.vivified > 0 {
                    println!("  shrinking removed {} literals; vivification shortened {} clauses by {} literals", st.shrunk, st.vivified, st.vivified_lits);
                }
                return;
            }
            let o = solver::solve(&p, threads);
            let once = t.elapsed();
            print!("{}", render(&p, &o));
            println!("{}×{}, {} search nodes, {:.1} µs", p.h, p.w, o.nodes, once.as_secs_f64() * 1e6);
            if std::env::var("NONO_VERBOSE").is_ok_and(|v| v != "0") {
                eprintln!("flow check: {} dead branches, {} cells forced; {} cubes",
                    solver::FLOW_DEAD.load(std::sync::atomic::Ordering::Relaxed), solver::FLOW_FORCED.load(std::sync::atomic::Ordering::Relaxed),
                    solver::CUBES.load(std::sync::atomic::Ordering::Relaxed));
            }
            if let Some(n) = flag(&args, "--bench") {
                let t = Instant::now();
                for _ in 0..n {
                    std::hint::black_box(solver::solve(std::hint::black_box(&p), threads));
                }
                println!("bench: {n} runs, {:.2} µs per solve", t.elapsed().as_secs_f64() / n as f64 * 1e6);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_heart() {
        let p = parse(include_str!("../puzzles/heart.txt")).unwrap();
        let o = solver::solve(&p, 1);
        assert_eq!(o.solutions.len(), 1);
        let heart = [
            "...............",
            "..###.....###..",
            ".#####...#####.",
            "#######.#######",
            "###############",
            "###############",
            "###############",
            ".#############.",
            "..###########..",
            "...#########...",
            "....#######....",
            ".....#####.....",
            "......###......",
            ".......#.......",
            "...............",
        ];
        let g = &o.solutions[0];
        let got: Vec<String> =
            (0..15).map(|r| (0..15).map(|c| if g.filled(r, c) { '#' } else { '.' }).collect()).collect();
        assert_eq!(got, heart);
    }

    /// The learning solver agrees with the probing search on solution
    /// counts, and its solutions satisfy the clues.
    #[test]
    fn cdcl_agrees_with_search() {
        for seed in 0..400 {
            let (w, h) = (4 + seed as usize % 14, 4 + (seed as usize * 5) % 14);
            let (rows, cols) = generate(w, h, 30 + seed % 40, seed + 77);
            let p = Puzzle::new(&rows, &cols);
            let a = solver::solve(&p, 1);
            let b = cdcl::solve(&p, None, None, None, 0, None);
            assert_eq!(a.solutions.len(), b.solutions.len(), "seed {seed} {w}x{h}");
            for g in &b.solutions {
                for r in 0..h {
                    assert_eq!(runs((0..w).map(|c| g.filled(r, c))), rows[r], "seed {seed} row {r}");
                }
                for c in 0..w {
                    assert_eq!(runs((0..h).map(|r| g.filled(r, c))), cols[c], "seed {seed} col {c}");
                }
            }
            if b.solutions.len() == 2 {
                assert!(
                    (0..h).any(|r| (0..w).any(|c| b.solutions[0].filled(r, c) != b.solutions[1].filled(r, c))),
                    "seed {seed}: same solution twice"
                );
            }
        }
    }

    #[test]
    fn two_solutions_are_found() {
        // The 2×2 diagonal: no line decides anything, and both fit.
        let p = parse("rows\n1\n1\ncols\n1\n1\n").unwrap();
        assert_eq!(solver::solve(&p, 1).solutions.len(), 2);
    }

    /// Every solution the solver returns satisfies the clues, on one thread
    /// and on several.
    #[test]
    fn random_puzzles_are_solved_correctly() {
        for threads in [1, 4] {
            for seed in 0..300 {
                let (w, h) = (5 + seed as usize % 16, 5 + (seed as usize * 7) % 16);
                let (rows, cols) = generate(w, h, 50, seed);
                let p = Puzzle::new(&rows, &cols);
                let o = solver::solve(&p, threads);
                assert!(!o.solutions.is_empty(), "seed {seed}: no solution");
                for g in &o.solutions {
                    for r in 0..h {
                        assert_eq!(runs((0..w).map(|c| g.filled(r, c))), rows[r], "seed {seed} row {r}");
                    }
                    for c in 0..w {
                        assert_eq!(runs((0..h).map(|r| g.filled(r, c))), cols[c], "seed {seed} col {c}");
                    }
                }
            }
        }
    }
}
