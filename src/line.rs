//! The line solver: one row or column, given its clue and the cells known
//! so far, returns every cell that the clue forces.
//!
//! It is exact, not an overlap heuristic: it finds every cell that is filled
//! in all placements of the blocks that fit the known cells, and every cell
//! that is empty in all of them.

pub type Mask = u128;

#[inline(always)]
pub fn ones(n: usize) -> Mask {
    if n >= 128 {
        !0
    } else {
        (1u128 << n) - 1
    }
}

// ── Bit-parallel line solver ────────────────────────────────────────────
//
// Shifts by l + 1 use checked_shr/checked_shl: when one block fills a line
// of 63 or 127 cells, l + 1 is the word width, and a plain shift by the
// width wraps to a shift of 0 in release builds (a wrong mask) and panics in
// debug builds.
//
// Positions 0..=n are bits of one machine word (so lines are at most 127
// cells); cell i is bit i. F[j]: positions where blocks 0..j fit in the cells before
// (separator after the last block included). S[j]: positions where block j
// can start with blocks j+1.. fitting after it. Every set operation is a
// handful of u128 instructions; the fills are Kogge-Stone (log n steps).

const MAX_BLOCKS: usize = 64;

// The solver is written once and instantiated for u64 (lines up to 63
// cells, one register per mask) and u128 (up to 127 cells). Most puzzles
// take the u64 path. The fills run log2(n) Kogge-Stone steps, not a fixed 7,
// and the per-block arrays are left uninitialised: the solver writes each
// entry before it reads it, so zeroing them would be wasted work. Zeroing
// 2 KB per call was 15 % of the run time.
macro_rules! line_solver {
    ($name:ident, $W:ty, $bounds:expr) => {
        /// With `$bounds`: block j may only start at positions in
        /// `allowed[j]`, and `starts[j]` receives its valid starts.
        #[inline(always)]
        #[allow(unused_variables)]
        fn $name(
            n: usize,
            clue: &[u32],
            filled: $W,
            empty: $W,
            allowed: &[$W],
            starts_out: &mut [$W],
        ) -> Option<($W, $W)> {
            const BITS: u32 = <$W>::BITS;
            let k = clue.len();
            let full: $W = if n as u32 >= BITS { !0 } else { (1 << n) - 1 };
            if k == 0 {
                return if filled != 0 { None } else { Some((0, full)) };
            }
            let ce = !filled & full; // can be empty
            let ne = !empty & full; // can be filled
            let end_bit: $W = 1 << n;
            let n32 = n as u32;

            // Positions reachable from `g` moving right over cells in `p`.
            let fill_right = |mut g: $W, mut p: $W| {
                let mut s = 1u32;
                while s <= n32 {
                    g |= (g & p) << s;
                    p &= p >> s;
                    s <<= 1;
                }
                g
            };
            // Position i joins when i + 1 is reachable and cell i is in `p`.
            let fill_left = |mut g: $W, mut p: $W| {
                let mut s = 1u32;
                while s <= n32 {
                    g |= (g >> s) & p;
                    p &= p >> s;
                    s <<= 1;
                }
                g
            };
            // Bit i set when cells i..i+l are all in `ok`.
            let runs_of = |ok: $W, l: u32| {
                let (mut res, mut t, mut w, mut off): ($W, $W, u32, u32) = (!0, ok, 1, 0);
                while w <= l {
                    if l & w != 0 {
                        res &= t >> off;
                        off += w;
                    }
                    t &= t >> w;
                    w <<= 1;
                }
                res
            };
            // Cells i..i+l for every i in `v`.
            let dilate = |v: $W, l: u32| {
                let (mut res, mut t, mut w, mut off): ($W, $W, u32, u32) = (0, v, 1, 0);
                while w <= l {
                    if l & w != 0 {
                        res |= t << off;
                        off += w;
                    }
                    t |= t << w;
                    w <<= 1;
                }
                res
            };

            let mut starts = std::mem::MaybeUninit::<[$W; MAX_BLOCKS]>::uninit();
            let mut bj = std::mem::MaybeUninit::<[$W; MAX_BLOCKS + 1]>::uninit();
            let sp = starts.as_mut_ptr() as *mut $W;
            let bp = bj.as_mut_ptr() as *mut $W;

            // Backward: S[j], the valid starts of block j given blocks j+1..,
            // and B[j], the positions from which blocks j.. fit.
            let mut b = fill_left(end_bit, ce);
            // SAFETY: k <= MAX_BLOCKS (a line of at most 127 cells has at most
            // 64 blocks), and every index read below is written here first.
            unsafe { bp.add(k).write(b) };
            for j in (0..k).rev() {
                let l = clue[j];
                let fit = runs_of(ne, l);
                let mut st = fit & (ce >> l) & b.checked_shr(l + 1).unwrap_or(0);
                if b & end_bit != 0 && n32 >= l {
                    st |= fit & (1 << (n32 - l));
                }
                if $bounds {
                    st &= allowed[j];
                }
                b = fill_left(st, ce);
                unsafe {
                    sp.add(j).write(st);
                    bp.add(j).write(b);
                }
            }
            if b & 1 == 0 {
                return None;
            }

            // Forward: the valid placements of block j are F[j] ∩ S[j].
            let mut f = fill_right(1, ce);
            let mut can_fill: $W = 0;
            let mut can_gap: $W = ce & f & (b >> 1) & full;
            for j in 0..k {
                let l = clue[j];
                let v = f & unsafe { sp.add(j).read() };
                if v == 0 {
                    return None;
                }
                if $bounds {
                    starts_out[j] = v;
                }
                can_fill |= dilate(v, l);
                let last = n32 - l; // v != 0, so l <= n
                let tail = v & !(1 << last);
                can_gap |= (tail << l) & full;
                let mut seeds = tail.checked_shl(l + 1).unwrap_or(0) & (full | end_bit);
                if v >> last & 1 == 1 {
                    seeds |= end_bit;
                }
                f = fill_right(seeds, ce);
                can_gap |= ce & f & (unsafe { bp.add(j + 1).read() } >> 1) & full;
            }
            if (can_fill | can_gap) & full != full {
                return None;
            }
            Some((filled | (can_fill & !can_gap), empty | (can_gap & !can_fill & full)))
        }
    };
}

line_solver!(solve64, u64, false);
line_solver!(solve128, u128, false);
line_solver!(solve64_bounds, u64, true);
line_solver!(solve128_bounds, u128, true);

// Feasibility only: does any placement of the blocks fit the known cells?
// The backward pass of the solver, stopping as soon as a block has no start.
// Explanations ask this question dozens of times per forced cell, and it
// costs about half a full solve.
macro_rules! line_feasible {
    ($name:ident, $W:ty, $bounds:expr) => {
        #[inline(always)]
        #[allow(unused_variables)]
        fn $name(n: usize, clue: &[u32], filled: $W, empty: $W, allowed: &[$W]) -> bool {
            const BITS: u32 = <$W>::BITS;
            let full: $W = if n as u32 >= BITS { !0 } else { (1 << n) - 1 };
            if clue.is_empty() {
                return filled == 0;
            }
            let ce = !filled & full;
            let ne = !empty & full;
            let end_bit: $W = 1 << n;
            let n32 = n as u32;
            let fill_left = |mut g: $W, mut p: $W| {
                let mut s = 1u32;
                while s <= n32 {
                    g |= (g >> s) & p;
                    p &= p >> s;
                    s <<= 1;
                }
                g
            };
            let runs_of = |ok: $W, l: u32| {
                let (mut res, mut t, mut w, mut off): ($W, $W, u32, u32) = (!0, ok, 1, 0);
                while w <= l {
                    if l & w != 0 {
                        res &= t >> off;
                        off += w;
                    }
                    t &= t >> w;
                    w <<= 1;
                }
                res
            };
            let mut b = fill_left(end_bit, ce);
            for j in (0..clue.len()).rev() {
                let l = clue[j];
                let fit = runs_of(ne, l);
                let mut st = fit & (ce >> l) & b.checked_shr(l + 1).unwrap_or(0);
                if b & end_bit != 0 && n32 >= l {
                    st |= fit & (1 << (n32 - l));
                }
                if $bounds {
                    st &= allowed[j];
                }
                if st == 0 {
                    return false;
                }
                b = fill_left(st, ce);
            }
            b & 1 != 0
        }
    };
}

line_feasible!(feasible64, u64, false);
line_feasible!(feasible128, u128, false);
line_feasible!(feasible64_bounds, u64, true);
line_feasible!(feasible128_bounds, u128, true);

/// Whether some placement of the blocks fits the known cells.
#[inline]
pub fn feasible(n: usize, clue: &[u32], filled: Mask, empty: Mask) -> bool {
    if filled & empty != 0 {
        return false;
    }
    if n < 64 {
        feasible64(n, clue, filled as u64, empty as u64, &[])
    } else {
        feasible128(n, clue, filled, empty, &[])
    }
}

/// As `feasible`, with block j allowed to start only at positions in
/// `allowed[j]` (one mask per block).
#[inline]
pub fn feasible_bounds(n: usize, clue: &[u32], filled: Mask, empty: Mask, allowed: &[Mask]) -> bool {
    if filled & empty != 0 {
        return false;
    }
    if n < 64 {
        let a: [u64; MAX_BLOCKS] = std::array::from_fn(|j| allowed.get(j).map_or(0, |&m| m as u64));
        feasible64_bounds(n, clue, filled as u64, empty as u64, &a)
    } else {
        feasible128_bounds(n, clue, filled, empty, allowed)
    }
}

/// As `solve`, with block j allowed to start only at positions in
/// `allowed[j]`; `starts[j]` receives the positions where block j can
/// start in some placement that fits (its new bounds are the lowest and the
/// highest bit).
#[inline]
pub fn solve_bounds(
    n: usize,
    clue: &[u32],
    filled: Mask,
    empty: Mask,
    allowed: &[Mask],
    starts: &mut [Mask],
) -> Option<(Mask, Mask)> {
    if n < 64 {
        let a: [u64; MAX_BLOCKS] = std::array::from_fn(|j| allowed.get(j).map_or(0, |&m| m as u64));
        let mut out = [0u64; MAX_BLOCKS];
        let r = solve64_bounds(n, clue, filled as u64, empty as u64, &a, &mut out);
        for j in 0..clue.len() {
            starts[j] = out[j] as Mask;
        }
        r.map(|(f, e)| (f as Mask, e as Mask))
    } else {
        solve128_bounds(n, clue, filled, empty, allowed, starts)
    }
}

/// Solve one line of `n` cells (1..=127). Returns the new (filled, empty)
/// masks, or None when no placement of the blocks fits the known cells.
#[inline]
pub fn solve(n: usize, clue: &[u32], filled: Mask, empty: Mask) -> Option<(Mask, Mask)> {
    if n < 64 {
        solve64(n, clue, filled as u64, empty as u64, &[], &mut []).map(|(f, e)| (f as Mask, e as Mask))
    } else {
        solve128(n, clue, filled, empty, &[], &mut [])
    }
}

/// The plain dynamic-programming line solver, O(cells × blocks) per line.
/// It is slower, but each step is easy to check by hand. The tests use it as
/// the reference for the bit-parallel solver.
#[cfg(test)]
pub mod oracle {
    use super::{ones, Mask};

    /// Scratch space for the line solver, reused across calls.
    pub struct Scratch {
        /// fwd[j * (n + 1) + i]: blocks 0..j fit in cells [0, i).
        pub fwd: Vec<bool>,
        /// bwd[j * (n + 2) + i]: blocks j.. fit in cells [i, n).
        pub bwd: Vec<bool>,
    }

    /// Solve one line exactly. Returns the new (filled, empty) masks, or None if
    /// no placement fits the known cells.
    pub fn solve_line(n: usize, clue: &[u32], filled: Mask, empty: Mask, s: &mut Scratch) -> Option<(Mask, Mask)> {
        let k = clue.len();
        let full = ones(n);
        if k == 0 {
            return if filled != 0 { None } else { Some((0, full)) };
        }
        let can_empty = |i: usize| filled >> i & 1 == 0;
        let fits = |start: usize, len: usize| start + len <= n && (empty >> start) & ones(len) == 0;

        let w1 = n + 1;
        s.fwd.clear();
        s.fwd.resize((k + 1) * w1, false);
        let fwd = &mut s.fwd;
        fwd[0] = true;
        for j in 0..=k {
            for i in 0..=n {
                if !fwd[j * w1 + i] {
                    continue;
                }
                if i < n && can_empty(i) {
                    fwd[j * w1 + i + 1] = true;
                }
                if j < k {
                    let l = clue[j] as usize;
                    if fits(i, l) {
                        let end = i + l;
                        if end == n {
                            fwd[(j + 1) * w1 + n] = true;
                        } else if can_empty(end) {
                            fwd[(j + 1) * w1 + end + 1] = true;
                        }
                    }
                }
            }
        }
        if !fwd[k * w1 + n] {
            return None;
        }

        let w2 = n + 2;
        s.bwd.clear();
        s.bwd.resize((k + 1) * w2, false);
        let bwd = &mut s.bwd;
        bwd[k * w2 + n] = true;
        for j in (0..=k).rev() {
            for i in (0..n).rev() {
                let mut ok = can_empty(i) && bwd[j * w2 + i + 1];
                if !ok && j < k {
                    let l = clue[j] as usize;
                    if fits(i, l) {
                        let end = i + l;
                        ok = if end == n {
                            bwd[(j + 1) * w2 + n]
                        } else {
                            can_empty(end) && bwd[(j + 1) * w2 + end + 1]
                        };
                    }
                }
                bwd[j * w2 + i] = ok;
            }
        }

        // Which cells can be filled, and which can be empty, in some placement.
        let mut can_fill: Mask = 0;
        let mut can_gap: Mask = 0;
        for i in 0..n {
            if can_empty(i) && (0..=k).any(|j| fwd[j * w1 + i] && bwd[j * w2 + i + 1]) {
                can_gap |= 1 << i;
            }
        }
        for j in 0..k {
            let l = clue[j] as usize;
            for st in 0..n {
                if !fwd[j * w1 + st] || !fits(st, l) {
                    continue;
                }
                let end = st + l;
                let rest = if end == n { bwd[(j + 1) * w2 + n] } else { can_empty(end) && bwd[(j + 1) * w2 + end + 1] };
                if rest {
                    can_fill |= ones(l) << st;
                    if end < n {
                        // The separator after the block is empty in this placement.
                        can_gap |= 1 << end;
                    }
                }
            }
        }
        let f = can_fill & !can_gap;
        let e = can_gap & !can_fill & full;
        if (can_fill | can_gap) & full != full {
            return None;
        }
        Some((filled | f, empty | e))
    }
}

#[cfg(test)]
mod tests {
    use super::oracle::{solve_line, Scratch};
    use super::*;

    fn line(n: usize, clue: &[u32], f: &str) -> String {
        let mut filled = 0;
        let mut empty = 0;
        for (i, ch) in f.chars().enumerate() {
            match ch {
                '#' => filled |= 1 << i,
                '.' => empty |= 1 << i,
                _ => {}
            }
        }
        match solve(n, clue, filled, empty) {
            None => "X".into(),
            Some((f, e)) => (0..n)
                .map(|i| {
                    if f >> i & 1 == 1 {
                        '#'
                    } else if e >> i & 1 == 1 {
                        '.'
                    } else {
                        '?'
                    }
                })
                .collect(),
        }
    }

    #[test]
    fn line_solver_is_exact() {
        assert_eq!(line(10, &[8], "??????????"), "??######??");
        assert_eq!(line(5, &[], "?????"), ".....");
        assert_eq!(line(5, &[5], "?????"), "#####");
        assert_eq!(line(5, &[2, 2], "?????"), "##.##");
        assert_eq!(line(6, &[1, 1], "?#????"), ".#.???");
        // Overlap alone finds nothing here; the exact solver does.
        assert_eq!(line(7, &[1, 1], "??#?#??"), "..#.#..");
        assert_eq!(line(4, &[3], "#..?"), "X");
        assert_eq!(line(5, &[1], "??#??"), "..#..");
        assert_eq!(line(127, &[127], &"?".repeat(127)), "#".repeat(127));
        // One block filling a line at the word width (63 or 127 cells).
        assert_eq!(line(63, &[63], &"?".repeat(63)), "#".repeat(63));
        assert_eq!(line(63, &[62], &"?".repeat(63)), format!("?{}?", "#".repeat(61)));
        assert_eq!(line(127, &[126], &"?".repeat(127)), format!("?{}?", "#".repeat(125)));
        assert_eq!(line(63, &[63], &format!(".{}", "?".repeat(62))), "X");
        assert!(feasible(63, &[63], 0, 0) && !feasible(63, &[63], 0, 1));
        assert!(feasible(127, &[127], 0, 0) && !feasible(127, &[127], 0, 1 << 126));
    }

    /// With start bounds: forced cells, valid starts and feasibility agree
    /// with enumerating every placement.
    #[test]
    fn bounds_match_brute_force() {
        #[allow(clippy::too_many_arguments)]
        fn place(
            j: usize,
            from: usize,
            n: usize,
            clue: &[u32],
            allowed: &[Mask],
            filled: Mask,
            empty: Mask,
            cur: &mut Vec<usize>,
            out: &mut Vec<Vec<usize>>,
        ) {
            if j == clue.len() {
                let mut cells: Mask = 0;
                for (b, &st) in cur.iter().enumerate() {
                    cells |= ones(clue[b] as usize) << st;
                }
                if cells & empty == 0 && filled & !cells == 0 {
                    out.push(cur.clone());
                }
                return;
            }
            let l = clue[j] as usize;
            for st in from..=n.saturating_sub(l) {
                if st + l > n || allowed[j] >> st & 1 == 0 {
                    continue;
                }
                cur.push(st);
                place(j + 1, st + l + 1, n, clue, allowed, filled, empty, cur, out);
                cur.pop();
            }
        }
        let mut x: u64 = 0x1234_5678_9abc_def1;
        let mut rnd = || {
            x ^= x << 13;
            x ^= x >> 7;
            x ^= x << 17;
            x
        };
        for _ in 0..40_000 {
            let n = 1 + (rnd() % 20) as usize;
            let truth: Mask = (0..n).fold(0, |m, i| if rnd() % 2 == 0 { m | 1 << i } else { m });
            let mut clue = Vec::new();
            let mut run = 0;
            for i in 0..=n {
                if i < n && truth >> i & 1 == 1 {
                    run += 1
                } else if run > 0 {
                    clue.push(run);
                    run = 0
                }
            }
            let known: Mask = (0..n).fold(0, |m, i| if rnd() % 4 == 0 { m | 1 << i } else { m });
            let filled = truth & known;
            let empty = !truth & known & ones(n);
            let allowed: Vec<Mask> = (0..clue.len())
                .map(|_| {
                    let a = (rnd() % (n as u64 + 1)) as usize;
                    let b = (rnd() % (n as u64 + 1)) as usize;
                    let (a, b) = (a.min(b), a.max(b));
                    ones(b + 1) & !ones(a)
                })
                .collect();
            let mut all = Vec::new();
            place(0, 0, n, &clue, &allowed, filled, empty, &mut Vec::new(), &mut all);
            let mut starts = vec![0 as Mask; clue.len()];
            let got = solve_bounds(n, &clue, filled, empty, &allowed, &mut starts);
            assert_eq!(feasible_bounds(n, &clue, filled, empty, &allowed), !all.is_empty(), "n={n} clue={clue:?}");
            if all.is_empty() {
                assert_eq!(got, None, "n={n} clue={clue:?} allowed={allowed:?}");
                continue;
            }
            let (mut can_fill, mut can_gap): (Mask, Mask) = (0, 0);
            let mut want = vec![0 as Mask; clue.len()];
            for pl in &all {
                let mut cells: Mask = 0;
                for (b, &st) in pl.iter().enumerate() {
                    cells |= ones(clue[b] as usize) << st;
                    want[b] |= 1 << st;
                }
                can_fill |= cells;
                can_gap |= !cells & ones(n);
            }
            let exp = (filled | (can_fill & !can_gap), empty | (can_gap & !can_fill));
            assert_eq!(got, Some(exp), "n={n} clue={clue:?} allowed={allowed:?}");
            assert_eq!(starts, want, "starts: n={n} clue={clue:?} allowed={allowed:?}");
        }
    }

    /// The bit-parallel solver agrees with the scalar one on random lines.
    #[test]
    fn matches_the_oracle() {
        let mut x: u64 = 0x9e3779b97f4a7c15;
        let mut rnd = || {
            x ^= x << 13;
            x ^= x >> 7;
            x ^= x << 17;
            x
        };
        let mut s = Scratch { fwd: vec![], bwd: vec![] };
        for _ in 0..300_000 {
            let n = 1 + (rnd() % 127) as usize;
            let dens = rnd() % 100;
            let truth: Mask = (0..n).fold(0, |m, i| if rnd() % 100 < dens { m | 1 << i } else { m });
            let mut clue = Vec::new();
            let mut run = 0;
            for i in 0..=n {
                if i < n && truth >> i & 1 == 1 {
                    run += 1
                } else if run > 0 {
                    clue.push(run);
                    run = 0
                }
            }
            let known: Mask = (0..n).fold(0, |m, i| if rnd() % 4 == 0 { m | 1 << i } else { m });
            let mut filled = truth & known;
            let mut empty = !truth & known & ones(n);
            // Sometimes a wrong cell, so contradictions are tested too.
            if rnd() % 5 == 0 {
                let i = (rnd() % n as u64) as usize;
                filled ^= 1 << i;
                empty &= !(1 << i);
            }
            let empty = empty & !filled;
            let fast = solve(n, &clue, filled, empty);
            assert_eq!(
                solve_line(n, &clue, filled, empty, &mut s),
                fast,
                "n={n} clue={clue:?} filled={filled:b} empty={empty:b}"
            );
            assert_eq!(feasible(n, &clue, filled, empty), fast.is_some(), "feasible: n={n} clue={clue:?}");
        }
    }
}
