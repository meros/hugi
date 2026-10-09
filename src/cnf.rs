//! The order encoding of a nonogram as clauses, shared by `hugi cnf`
//! (the SAT-solver reference) and the learning solver, which adds these
//! clauses so it can learn rules over block positions, not only cells.
//!
//! Order encoding per line. For block j, y(j, p) means "block j starts at
//! position >= p", for p in its feasible range [lo_j, hi_j + 1]; y(j, lo_j)
//! is true and y(j, hi_j + 1) false. Clauses: y(j, p+1) -> y(j, p);
//! block j+1 starts after block j and a gap: y(j, p) -> y(j+1, p + len_j + 1).
//!
//! Cells, two ways. `Cover` (the reference): cell c is covered by block j iff
//! y(j, c - len_j + 1) and not y(j, c + 1), through an auxiliary cover
//! variable, and a cell is filled iff some block covers it.
//!
//! `Lean`: no auxiliary variables. A cell covered by some block is filled:
//! x | !y(j, c - len_j + 1) | y(j, c + 1) for each j. A filled cell is
//! covered by the last block that starts at or before it, since blocks are
//! ordered: !x | y(j, c + 1) | !y(j + 1, c + 1) | y(j, c - len_j + 1), and
//! !x | !y(0, c + 1). In the learning solver the cover variables were half
//! of all propagations (862 of 1 723 per conflict on a random 50x50).

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Encoding {
    Cover,
    Lean,
}

/// The encoding the learning solver and `hugi cnf` use (NONO_ENC=cover
/// for the old one). Lean measured 2026-10-09 on 72 random puzzles,
/// strategy 1 alone, 60 G-instruction budget: 71/72 solved against 68/72,
/// PAR-2 620 against 1 156 G instructions. kissat gains from it as well
/// (r50x50-6008: 5 s against 7 s, same conflicts).
pub fn chosen() -> Encoding {
    match std::env::var("NONO_ENC").as_deref() {
        Ok("cover") => Encoding::Cover,
        _ => Encoding::Lean,
    }
}

/// One block of one line, for a solver that propagates the ladder itself
/// (`encode_with_ladder`): y(j, p) is variable `base + p - lo` (0-based) for
/// p in lo..=hi+1, and the next block of the line starts at least `gap`
/// after this one.
#[derive(Clone, Copy, Debug)]
pub struct Block {
    pub base: u32,
    pub lo: u32,
    pub hi: u32,
    pub next: Option<(u32, u32)>,
}

pub fn encode(rows: &[Vec<u32>], cols: &[Vec<u32>], enc: Encoding) -> (usize, Vec<Vec<i64>>) {
    encode_full(rows, cols, enc, None, false, true)
}

/// The general form: `blocks` receives the blocks; `own_ladder` leaves the
/// chain and ordering clauses out (the solver applies them); without
/// `cell_clauses` the clauses between cells and block starts are left out
/// too, for a solver whose line propagator links them.
pub fn encode_full(
    rows: &[Vec<u32>],
    cols: &[Vec<u32>],
    enc: Encoding,
    mut blocks: Option<&mut Vec<Block>>,
    own_ladder: bool,
    cell_clauses: bool,
) -> (usize, Vec<Vec<i64>>) {
    let (h, w) = (rows.len(), cols.len());
    let mut next = (h * w) as i64 + 1;
    let mut clauses: Vec<Vec<i64>> = Vec::new();
    for line in 0..h + w {
        let (clue, n) = if line < h { (&rows[line], w) } else { (&cols[line - h], h) };
        let cell = |i: usize| -> i64 {
            if line < h {
                (line * w + i + 1) as i64
            } else {
                (i * w + (line - h) + 1) as i64
            }
        };
        encode_line(clue, n, cell, &mut next, enc, &mut clauses, blocks.as_deref_mut(), own_ladder, cell_clauses);
    }
    ((next - 1) as usize, clauses)
}

/// A literal or a constant, while clauses are built.
#[derive(Clone, Copy)]
enum T {
    Const(bool),
    Lit(i64),
}

impl T {
    fn neg(self) -> T {
        match self {
            T::Const(b) => T::Const(!b),
            T::Lit(l) => T::Lit(-l),
        }
    }
}

/// Push the clause unless a constant satisfies it; constants false drop out.
fn push(out: &mut Vec<Vec<i64>>, terms: &[T]) {
    let mut c = Vec::with_capacity(terms.len());
    for &t in terms {
        match t {
            T::Const(true) => return,
            T::Const(false) => {}
            T::Lit(l) => c.push(l),
        }
    }
    out.push(c);
}

#[allow(clippy::too_many_arguments)]
fn encode_line(
    clue: &[u32],
    n: usize,
    cell: impl Fn(usize) -> i64,
    next: &mut i64,
    enc: Encoding,
    clauses: &mut Vec<Vec<i64>>,
    ladder: Option<&mut Vec<Block>>,
    own: bool,
    cell_clauses: bool,
) {
    let mut fresh = || {
        let v = *next;
        *next += 1;
        v
    };
    let k = clue.len();
    if k == 0 {
        for i in 0..n {
            clauses.push(vec![-cell(i)]);
        }
        return;
    }
    // Feasible start ranges.
    let mut lo = vec![0usize; k];
    let mut hi = vec![0usize; k];
    let mut acc = 0;
    for j in 0..k {
        lo[j] = acc;
        acc += clue[j] as usize + 1;
    }
    let mut acc = n;
    for j in (0..k).rev() {
        hi[j] = acc - clue[j] as usize;
        acc = hi[j].saturating_sub(1);
    }
    // y[j][p - lo[j]] for p in lo..=hi+1.
    let y: Vec<Vec<i64>> = (0..k).map(|j| (lo[j]..=hi[j] + 1).map(|_| fresh()).collect()).collect();
    let yv = |j: usize, p: usize| -> Option<bool> {
        if p <= lo[j] {
            Some(true)
        } else if p > hi[j] {
            Some(false)
        } else {
            None
        }
    };
    let ylit = |j: usize, p: usize| y[j][p - lo[j]];
    let yt = |j: usize, p: usize| -> T { yv(j, p).map_or_else(|| T::Lit(ylit(j, p)), T::Const) };
    if let Some(l) = ladder {
        let first = l.len() as u32;
        for j in 0..k {
            let next = (j + 1 < k).then(|| (first + j as u32 + 1, clue[j] + 1));
            l.push(Block { base: (ylit(j, lo[j]) - 1) as u32, lo: lo[j] as u32, hi: hi[j] as u32, next });
        }
    }
    for j in 0..k {
        clauses.push(vec![ylit(j, lo[j])]);
        clauses.push(vec![-ylit(j, hi[j] + 1)]);
        if !own {
            for p in lo[j]..=hi[j] {
                clauses.push(vec![-ylit(j, p + 1), ylit(j, p)]);
            }
        }
        if j + 1 < k {
            let gap = clue[j] as usize + 1;
            for p in lo[j]..=hi[j] + 1 {
                let q = p + gap;
                match yv(j + 1, q) {
                    Some(true) => {}
                    Some(false) => clauses.push(vec![-ylit(j, p)]),
                    None if !own => clauses.push(vec![-ylit(j, p), ylit(j + 1, q)]),
                    None => {}
                }
            }
        }
    }
    if !cell_clauses {
        return;
    }
    match enc {
        Encoding::Cover => {
            for c in 0..n {
                let mut covers = Vec::new();
                for j in 0..k {
                    let l = clue[j] as usize;
                    // Covered iff start in [c - l + 1, c].
                    let a = (c + 1).saturating_sub(l);
                    if c < lo[j] || a > hi[j] {
                        continue;
                    }
                    let v = fresh();
                    // v <-> y(j, a) & !y(j, c + 1)
                    let ya = if a <= lo[j] { None } else { Some(ylit(j, a)) };
                    let yb = if c + 1 > hi[j] { None } else { Some(ylit(j, c + 1)) };
                    let mut back = vec![v];
                    if let Some(ya) = ya {
                        clauses.push(vec![-v, ya]);
                        back.push(-ya);
                    }
                    if let Some(yb) = yb {
                        clauses.push(vec![-v, -yb]);
                        back.push(yb);
                    }
                    clauses.push(back);
                    covers.push(v);
                }
                let x = cell(c);
                let mut any = vec![-x];
                for &v in &covers {
                    clauses.push(vec![-v, x]);
                    any.push(v);
                }
                clauses.push(any);
            }
        }
        Encoding::Lean => {
            for c in 0..n {
                let x = T::Lit(cell(c));
                push(clauses, &[x.neg(), yt(0, c + 1).neg()]);
                for j in 0..k {
                    let a = (c + 1).saturating_sub(clue[j] as usize);
                    // Covered by j means filled.
                    push(clauses, &[x, yt(j, a).neg(), yt(j, c + 1)]);
                    // Filled, and j the last block starting at or before c:
                    // j covers c.
                    let after = if j + 1 < k { yt(j + 1, c + 1).neg() } else { T::Const(false) };
                    push(clauses, &[x.neg(), yt(j, c + 1), after, yt(j, a)]);
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn runs(cells: &[bool]) -> Vec<u32> {
        let mut out = Vec::new();
        let mut run = 0;
        for &f in cells.iter().chain([false].iter()) {
            if f {
                run += 1;
            } else if run > 0 {
                out.push(run);
                run = 0;
            }
        }
        out
    }

    /// Satisfiable with the cells fixed, by brute force over the auxiliary
    /// variables (cells are variables 1..=n).
    fn sat_with(cells: &[bool], nvars: usize, clauses: &[Vec<i64>]) -> bool {
        let n = cells.len();
        let aux = nvars - n;
        (0u64..1 << aux).any(|m| {
            let val = |l: i64| -> bool {
                let v = l.unsigned_abs() as usize - 1;
                let b = if v < n { cells[v] } else { m >> (v - n) & 1 == 1 };
                if l > 0 {
                    b
                } else {
                    !b
                }
            };
            clauses.iter().all(|c| c.iter().any(|&l| val(l)))
        })
    }

    #[test]
    fn encodings_allow_exactly_the_matching_lines() {
        for n in 1..=7usize {
            // Every clue that fits in n cells.
            let mut clues: Vec<Vec<u32>> = Vec::new();
            for mask in 0u32..1 << n {
                let cells: Vec<bool> = (0..n).map(|i| mask >> i & 1 == 1).collect();
                let r = runs(&cells);
                if !clues.contains(&r) {
                    clues.push(r);
                }
            }
            for clue in &clues {
                for enc in [Encoding::Cover, Encoding::Lean] {
                    let mut next = n as i64 + 1;
                    let mut cl = Vec::new();
                    encode_line(clue, n, |i| i as i64 + 1, &mut next, enc, &mut cl, None, false, true);
                    let nvars = (next - 1) as usize;
                    if nvars - n > 18 {
                        continue; // too many auxiliary variables to enumerate
                    }
                    for mask in 0u32..1 << n {
                        let cells: Vec<bool> = (0..n).map(|i| mask >> i & 1 == 1).collect();
                        assert_eq!(
                            sat_with(&cells, nvars, &cl),
                            runs(&cells) == *clue,
                            "{enc:?} n={n} clue={clue:?} cells={cells:?}"
                        );
                    }
                }
            }
        }
    }
}
