//! Propagation and search over the whole grid.
//!
//! The grid is one flat array: for each line (rows first, then columns) the
//! mask of cells known filled and the mask known empty, side by side. A
//! 15×15 grid is 960 bytes and a 127×127 one 8 KB, so a whole grid sits in
//! L1 and copying it for a search branch is one short memcpy.
//!
//! Propagation keeps no queue: the rows to revisit are bits of one u128 and
//! the columns bits of another. It sweeps all dirty rows, then all dirty
//! columns, until both are empty.
//!
//! Before every branch the solver probes: it tries both values of every
//! unknown cell with full propagation. A value that fails forces the other,
//! and cells on which both values agree are forced too. When a whole sweep
//! forces nothing, it branches on the cell whose weaker value settles the
//! most cells, reusing the two grids the probe already built. A puzzle that
//! needs search runs on one thread for a short solo phase first, because
//! starting threads costs more than most searches. After that every core
//! joins, and a thread that branches while another is idle hands its second
//! branch over.
//!
//! The tunable choices live in `Config`, read once from `NONO_*` environment
//! variables, so a benchmark can compare them without a rebuild.

use crate::clock::Instant;
use crate::line::{self, ones, Mask};
use std::sync::atomic::{
    AtomicBool, AtomicU64, AtomicUsize,
    Ordering::{Relaxed, SeqCst},
};
use std::sync::{Arc, Condvar, Mutex};
use std::time::Duration;

/// The solver's tunable choices. Defaults are the empirical best; see
/// `tune/README.md` for how they were chosen.
#[derive(Clone, Copy, Debug)]
pub struct Config {
    /// Branch score from the cells settled by each value (ka, kb):
    /// 0 min-first, 1 product, 2 sum, 3 min²·max, 4 product then min.
    pub score: u8,
    /// Which child to search first: 0 filled, 1 empty, 2 the one that
    /// settles more cells, 3 the one that settles fewer.
    pub order: u8,
    /// Probe only at search depth below this; deeper nodes branch on the
    /// first unknown cell of the line with fewest unknowns.
    pub probe_depth: u32,
    /// After a forced cell, restart the sweep from the top (true) or carry on.
    pub restart: bool,
    /// One thread searches alone this long before the others join.
    pub solo_us: u64,
    /// Line cache entries, as a power of two.
    pub cache_bits: u32,
    /// Split the open cells into independent parts and solve them apart.
    pub parts: bool,
    /// 0 portfolio (learning solver on one thread, probing search on the
    /// rest), 1 probing search only, 2 learning solver only.
    pub engine: u8,
    /// Threads given to the learning solver in the portfolio; the probing
    /// search gets the rest.
    pub cdcl_threads: usize,
    /// After this long without an answer, the portfolio moves cores from
    /// the probing search until `grow_to` learning threads run.
    pub grow_ms: u64,
    pub grow_to: usize,
    /// Probing threads left after the switch (default: the cores freed by
    /// the new learning threads come from the probing side, the rest stay).
    pub grow_dfs: usize,
    /// Pin the first learning thread to the fastest core.
    pub pin: bool,
    /// Share cells that hold in every solution between the engines.
    pub share: bool,
    /// Run the global row/column count check (max-flow) in the probing search.
    pub flow: bool,
    /// Cube-and-conquer: hand subtrees at this search depth to a learning
    /// solver running strategy `cube_seed` (0 = off).
    pub cube_depth: u32,
    pub cube_seed: u64,
    /// Threads for a cube-and-conquer arm started at the growth switch, at
    /// depth `cube_arm_depth` (0 = no arm).
    pub cube_arm: usize,
    pub cube_arm_depth: u32,
    /// Learning threads beyond the first two stop after this many ms (0 = never).
    pub retire_ms: u64,
}

impl Config {
    pub const DEFAULT: Config = Config {
        score: 1,
        order: 0,
        probe_depth: u32::MAX,
        restart: false,
        solo_us: 2000,
        cache_bits: 14,
        parts: true,
        engine: 0,
        cdcl_threads: 4,
        grow_ms: 1000,
        grow_to: 2,
        grow_dfs: 1,
        pin: false,
        share: true,
        flow: false,
        cube_depth: 0,
        cube_seed: 1,
        cube_arm: 0,
        cube_arm_depth: 8,
        retire_ms: 3000,
    };

    fn from_env() -> Config {
        let get = |k: &str| std::env::var(k).ok().and_then(|v| v.parse::<u64>().ok());
        let d = Config::DEFAULT;
        Config {
            score: get("NONO_SCORE").map_or(d.score, |v| v as u8),
            order: get("NONO_ORDER").map_or(d.order, |v| v as u8),
            probe_depth: get("NONO_PROBE_DEPTH").map_or(d.probe_depth, |v| v as u32),
            restart: get("NONO_RESTART").map_or(d.restart, |v| v != 0),
            solo_us: get("NONO_SOLO_US").unwrap_or(d.solo_us),
            cache_bits: get("NONO_CACHE_BITS").map_or(d.cache_bits, |v| v as u32).clamp(4, 24),
            parts: get("NONO_PARTS").map_or(d.parts, |v| v != 0),
            engine: get("NONO_ENGINE").map_or(d.engine, |v| v as u8),
            cdcl_threads: get("NONO_CDCL_THREADS").map_or(d.cdcl_threads, |v| v as usize),
            grow_ms: get("NONO_GROW_MS").unwrap_or(d.grow_ms),
            grow_to: get("NONO_GROW_TO").map_or(d.grow_to, |v| v as usize),
            grow_dfs: get("NONO_GROW_DFS").map_or(d.grow_dfs, |v| v as usize),
            pin: get("NONO_PIN").map_or(d.pin, |v| v != 0),
            share: get("NONO_SHARE").map_or(d.share, |v| v != 0),
            flow: get("NONO_FLOW").map_or(d.flow, |v| v != 0),
            cube_depth: get("NONO_CUBE_DEPTH").map_or(d.cube_depth, |v| v as u32),
            cube_seed: get("NONO_CUBE_SEED").unwrap_or(d.cube_seed),
            cube_arm: get("NONO_CUBE_ARM").map_or(d.cube_arm, |v| v as usize),
            cube_arm_depth: get("NONO_CUBE_ARM_DEPTH").map_or(d.cube_arm_depth, |v| v as u32),
            retire_ms: get("NONO_RETIRE_MS").unwrap_or(d.retire_ms),
        }
    }
}

pub fn config() -> &'static Config {
    static C: std::sync::OnceLock<Config> = std::sync::OnceLock::new();
    C.get_or_init(Config::from_env)
}

#[derive(Clone)]
pub struct Puzzle {
    pub h: usize,
    pub w: usize,
    /// Distinguishes puzzles in the line cache, which outlives a puzzle.
    id: u32,
    clues: Vec<u32>,
    /// Per line: start and length in `clues`.
    spans: Vec<(u32, u32)>,
}

impl Puzzle {
    pub fn new(rows: &[Vec<u32>], cols: &[Vec<u32>]) -> Puzzle {
        let mut clues = Vec::new();
        let mut spans = Vec::new();
        for c in rows.iter().chain(cols) {
            spans.push((clues.len() as u32, c.len() as u32));
            clues.extend(c.iter().copied().filter(|&v| v > 0));
            spans.last_mut().unwrap().1 = (clues.len() as u32) - spans.last().unwrap().0;
        }
        static NEXT_ID: AtomicUsize = AtomicUsize::new(0);
        let id = NEXT_ID.fetch_add(1, Relaxed) as u32;
        Puzzle { h: rows.len(), w: cols.len(), id, clues, spans }
    }

    #[inline(always)]
    pub(crate) fn clue(&self, line: usize) -> &[u32] {
        let (s, l) = self.spans[line];
        &self.clues[s as usize..(s + l) as usize]
    }
}

#[derive(Clone)]
pub struct Grid {
    /// m[2 * line] known filled, m[2 * line + 1] known empty.
    pub(crate) m: Vec<Mask>,
}

impl Grid {
    pub fn filled(&self, r: usize, c: usize) -> bool {
        self.m[2 * r] >> c & 1 == 1
    }

    fn solved(&self, p: &Puzzle) -> bool {
        let full = ones(p.w);
        (0..p.h).all(|r| self.m[2 * r] | self.m[2 * r + 1] == full)
    }

    #[inline(always)]
    fn set(&mut self, p: &Puzzle, r: usize, c: usize, fill: bool) {
        let o = !fill as usize;
        self.m[2 * r + o] |= 1 << c;
        self.m[2 * (p.h + c) + o] |= 1 << r;
    }
}

// ── Line cache ──────────────────────────────────────────────────────────
//
// Probing solves the same line in the same state many times: every probe
// starts from the same grid and touches mostly the same lines. A
// direct-mapped cache per thread keyed by (puzzle, line, filled, empty)
// returns the earlier answer. One entry is 80 bytes and 2^14 entries are
// 1.3 MB, which fits in L2.

#[derive(Clone, Copy)]
struct Entry {
    f: Mask,
    e: Mask,
    rf: Mask,
    re: Mask,
    /// Puzzle id << 8 | line, with bit 63 set when the line had no solution.
    key: u64,
}

const EMPTY_KEY: u64 = u64::MAX;

thread_local! {
    static CACHE: std::cell::UnsafeCell<Vec<Entry>> = std::cell::UnsafeCell::new(
        vec![Entry { f: 0, e: 0, rf: 0, re: 0, key: EMPTY_KEY }; 1 << config().cache_bits]);
    static CACHE_SHIFT: u32 = 64 - config().cache_bits;
}

#[inline(always)]
pub(crate) fn solve_line(p: &Puzzle, line: usize, n: usize, f0: Mask, e0: Mask) -> Option<(Mask, Mask)> {
    let key = (p.id as u64) << 8 | line as u64;
    let fold = |x: Mask| (x as u64) ^ ((x >> 64) as u64).rotate_left(29);
    let h = (fold(f0).wrapping_mul(0x9E37_79B9_7F4A_7C15)
        ^ fold(e0).wrapping_mul(0xC2B2_AE3D_27D4_EB4F)
        ^ key.wrapping_mul(0x1656_67B1_9E37_79F9))
        >> CACHE_SHIFT.with(|s| *s);
    CACHE.with(|c| {
        // SAFETY: the cache is this thread's own and no reference escapes.
        let slot = unsafe { &mut (&mut *c.get())[h as usize] };
        if slot.f == f0 && slot.e == e0 && slot.key & !(1 << 63) == key {
            return if slot.key >> 63 == 1 { None } else { Some((slot.rf, slot.re)) };
        }
        let r = line::solve(n, p.clue(line), f0, e0);
        *slot = match r {
            Some((rf, re)) => Entry { f: f0, e: e0, rf, re, key },
            None => Entry { f: f0, e: e0, rf: 0, re: 0, key: key | 1 << 63 },
        };
        r
    })
}

/// What a propagation changed: the rows and columns it wrote, and how many
/// cells it settled. Each cell is settled once, by its row or its column, so
/// the count needs no grid scan.
#[derive(Default, Clone, Copy)]
struct Touch {
    rows: Mask,
    cols: Mask,
    newly: u32,
    /// Lines the propagation solved, changed or not: its result depends on
    /// exactly these.
    vrows: Mask,
    vcols: Mask,
}

/// Propagate from the dirty rows and columns. False on a contradiction.
#[inline]
pub(crate) fn propagate(p: &Puzzle, g: &mut Grid, rows: Mask, cols: Mask) -> bool {
    propagate_t(p, g, rows, cols, &mut Touch::default())
}

#[inline(always)]
fn propagate_t(p: &Puzzle, g: &mut Grid, mut rows: Mask, mut cols: Mask, t: &mut Touch) -> bool {
    let (h, w) = (p.h, p.w);
    while rows | cols != 0 {
        while rows != 0 {
            let r = rows.trailing_zeros() as usize;
            rows &= rows - 1;
            t.vrows |= 1 << r;
            let (f0, e0) = (g.m[2 * r], g.m[2 * r + 1]);
            let Some((f, e)) = solve_line(p, r, w, f0, e0) else { return false };
            let (nf, ne) = (f & !f0, e & !e0);
            if nf | ne == 0 {
                continue;
            }
            g.m[2 * r] = f;
            g.m[2 * r + 1] = e;
            cols |= nf | ne;
            t.rows |= 1 << r;
            t.cols |= nf | ne;
            t.newly += (nf | ne).count_ones();
            let bit = 1 << r;
            let mut x = nf;
            while x != 0 {
                let c = x.trailing_zeros() as usize;
                x &= x - 1;
                g.m[2 * (h + c)] |= bit;
            }
            let mut x = ne;
            while x != 0 {
                let c = x.trailing_zeros() as usize;
                x &= x - 1;
                g.m[2 * (h + c) + 1] |= bit;
            }
        }
        while cols != 0 {
            let c = cols.trailing_zeros() as usize;
            cols &= cols - 1;
            t.vcols |= 1 << c;
            let l = h + c;
            let (f0, e0) = (g.m[2 * l], g.m[2 * l + 1]);
            let Some((f, e)) = solve_line(p, l, h, f0, e0) else { return false };
            let (nf, ne) = (f & !f0, e & !e0);
            if nf | ne == 0 {
                continue;
            }
            g.m[2 * l] = f;
            g.m[2 * l + 1] = e;
            rows |= nf | ne;
            t.cols |= 1 << c;
            t.rows |= nf | ne;
            t.newly += (nf | ne).count_ones();
            let bit = 1 << c;
            let mut x = nf;
            while x != 0 {
                let r = x.trailing_zeros() as usize;
                x &= x - 1;
                g.m[2 * r] |= bit;
            }
            let mut x = ne;
            while x != 0 {
                let r = x.trailing_zeros() as usize;
                x &= x - 1;
                g.m[2 * r + 1] |= bit;
            }
        }
    }
    true
}

/// Set cell (r, c) to `fill` in `a`, which equals `g`, and propagate.
#[inline(always)]
fn probe_side(p: &Puzzle, a: &mut Grid, r: usize, c: usize, fill: bool) -> (bool, Touch) {
    let mut t = Touch { rows: 1 << r, cols: 1 << c, newly: 1, vrows: 0, vcols: 0 };
    a.set(p, r, c, fill);
    let ok = propagate_t(p, a, 1 << r, 1 << c, &mut t);
    (ok, t)
}

/// Copy back from `g` only the lines a probe wrote.
#[inline(always)]
fn restore(p: &Puzzle, a: &mut Grid, g: &Grid, t: &Touch) {
    for (mut x, base) in [(t.rows, 0), (t.cols, p.h)] {
        while x != 0 {
            let l = base + x.trailing_zeros() as usize;
            x &= x - 1;
            a.m[2 * l] = g.m[2 * l];
            a.m[2 * l + 1] = g.m[2 * l + 1];
        }
    }
}

/// Cells known to hold in every solution, shared by the portfolio's
/// engines: the probing search publishes its root, the learning threads
/// their unit clauses learned before the first solution. Each engine imports
/// new facts when the version moves: learning threads at a restart, probing
/// threads at the start of a node.
pub struct Facts {
    version: AtomicU64,
    m: Mutex<Vec<Mask>>,
    /// Short learned clauses over cell literals, with the exporting
    /// thread's seed, shared between learning threads.
    clauses: Mutex<Vec<(u64, Vec<u32>)>>,
    nclauses: AtomicUsize,
}

impl Facts {
    pub(crate) fn new(p: &Puzzle) -> Facts {
        Facts {
            version: AtomicU64::new(0),
            m: Mutex::new(vec![0; 2 * (p.h + p.w)]),
            clauses: Mutex::new(Vec::new()),
            nclauses: AtomicUsize::new(0),
        }
    }

    pub(crate) fn version(&self) -> u64 {
        self.version.load(Relaxed)
    }

    /// Merge a grid whose known cells hold in every solution.
    pub(crate) fn publish(&self, g: &Grid) {
        let mut m = self.m.lock().unwrap();
        let mut new = false;
        for (x, y) in m.iter_mut().zip(&g.m) {
            if *y & !*x != 0 {
                *x |= *y;
                new = true;
            }
        }
        if new {
            self.version.fetch_add(1, SeqCst);
        }
    }

    pub(crate) fn publish_cell(&self, p: &Puzzle, r: usize, c: usize, fill: bool) {
        let mut m = self.m.lock().unwrap();
        let o = !fill as usize;
        if m[2 * r + o] >> c & 1 == 0 {
            m[2 * r + o] |= 1 << c;
            m[2 * (p.h + c) + o] |= 1 << r;
            self.version.fetch_add(1, SeqCst);
        }
    }

    pub(crate) fn export_clause(&self, seed: u64, lits: &[u32]) {
        let mut c = self.clauses.lock().unwrap();
        c.push((seed, lits.to_vec()));
        self.nclauses.store(c.len(), SeqCst);
    }

    pub(crate) fn clause_count(&self) -> usize {
        self.nclauses.load(Relaxed)
    }

    /// Clauses from index `from` on that other threads exported.
    pub(crate) fn clauses_since(&self, from: usize, seed: u64) -> (usize, Vec<Vec<u32>>) {
        let c = self.clauses.lock().unwrap();
        let out = c[from.min(c.len())..].iter().filter(|(s, _)| *s != seed).map(|(_, l)| l.clone()).collect();
        (c.len(), out)
    }

    pub(crate) fn snapshot(&self) -> (u64, Vec<Mask>) {
        let m = self.m.lock().unwrap();
        (self.version(), m.clone())
    }
}

/// What probing knows from earlier sweeps, carried from a node to its
/// children: per cell the epoch, score and solved lines of its last probe,
/// per line the epoch it last changed. A child differs from its parent only
/// in the lines its branch wrote, so probes elsewhere keep their scores.
#[derive(Clone)]
pub(crate) struct ProbeMemo {
    cells: Vec<(u32, u64, Mask, Mask)>,
    line_epoch: Vec<u32>,
    epoch: u32,
}

impl ProbeMemo {
    pub(crate) fn new(p: &Puzzle) -> ProbeMemo {
        ProbeMemo { cells: vec![(0, 0, 0, 0); p.h * p.w], line_epoch: vec![0; p.h + p.w], epoch: 1 }
    }

    /// Lines that changed in the grid: probes that solved them are stale.
    fn changed(&mut self, p: &Puzzle, rows: Mask, cols: Mask) {
        self.epoch += 1;
        for (mut x, base) in [(rows, 0), (cols, p.h)] {
            while x != 0 {
                self.line_epoch[base + x.trailing_zeros() as usize] = self.epoch;
                x &= x - 1;
            }
        }
    }

    fn stale(&self, p: &Puzzle, since: u32, rows: Mask, cols: Mask) -> bool {
        for (mut x, base) in [(rows, 0), (cols, p.h)] {
            while x != 0 {
                if self.line_epoch[base + x.trailing_zeros() as usize] > since {
                    return true;
                }
                x &= x - 1;
            }
        }
        false
    }
}

pub(crate) enum Probed {
    Contradiction,
    Solved,
    /// The cell to branch on, as its two propagated children (filled, then
    /// empty), the cells each settles, and the lines each wrote.
    Branch(Grid, Grid, u64, u64, (Mask, Mask), (Mask, Mask)),
}

/// Probe every unknown cell, both values, until a full sweep forces
/// nothing. A value that fails forces the other; cells that both values
/// agree on are forced as well. The last sweep also scores every cell, and
/// the best one (most cells settled by its weaker value) is returned as the
/// branch, already propagated.
pub(crate) fn probe(p: &Puzzle, g: &mut Grid, act: Mask, memo: &mut ProbeMemo) -> Probed {
    // `a` and `b` stay equal to `g` between probes: each probe writes a few
    // lines and `restore` puts back only those.
    let mut a = g.clone();
    let mut b = g.clone();
    let cfg = config();
    // A probe is a deterministic propagation, so its result can only change
    // if a line it solved has changed in `g` since (see ProbeMemo). A cell
    // whose lines are all older is skipped and keeps its score, so the sweep
    // order, the scores and the search tree are exactly the same.
    let mut best: Option<(u64, usize, usize)>;
    loop {
        let mut progressed = false;
        best = None;
        let mut rows = act;
        'sweep: while rows != 0 {
            let r = rows.trailing_zeros() as usize;
            rows &= rows - 1;
            let mut unk = ones(p.w) & !(g.m[2 * r] | g.m[2 * r + 1]);
            while unk != 0 {
                let c = unk.trailing_zeros() as usize;
                unk &= unk - 1;
                if (g.m[2 * r] | g.m[2 * r + 1]) >> c & 1 == 1 {
                    continue; // settled earlier in this sweep
                }
                let (pe, pscore, pr, pc) = memo.cells[r * p.w + c];
                if pe != 0 && !memo.stale(p, pe, pr, pc) {
                    // Same probe result as last time: both values survive and
                    // force nothing in common.
                    if !progressed && best.is_none_or(|x| pscore > x.0) {
                        best = Some((pscore, r, c));
                    }
                    continue;
                }
                let (ok_a, ta) = probe_side(p, &mut a, r, c, true);
                let (ok_b, tb) = probe_side(p, &mut b, r, c, false);
                match (ok_a, ok_b) {
                    (false, false) => return Probed::Contradiction,
                    (true, false) | (false, true) => {
                        let t = if ok_a { ta } else { tb };
                        if ok_a {
                            std::mem::swap(g, &mut a)
                        } else {
                            std::mem::swap(g, &mut b)
                        }
                        a.m.copy_from_slice(&g.m);
                        b.m.copy_from_slice(&g.m);
                        memo.changed(p, t.rows, t.cols);
                        progressed = true;
                        if cfg.restart {
                            break 'sweep;
                        }
                    }
                    (true, true) => {
                        // Cells both values settle the same way are forced.
                        // Only lines both probes wrote can hold one.
                        let (mut dr, mut dc) = (0 as Mask, 0 as Mask);
                        for (mut x, base) in [(ta.rows & tb.rows, 0), (ta.cols & tb.cols, p.h)] {
                            while x != 0 {
                                let l = base + x.trailing_zeros() as usize;
                                x &= x - 1;
                                for i in [2 * l, 2 * l + 1] {
                                    let add = a.m[i] & b.m[i] & !g.m[i];
                                    if add != 0 {
                                        g.m[i] |= add;
                                        if l < p.h {
                                            dr |= 1 << l
                                        } else {
                                            dc |= 1 << (l - p.h)
                                        }
                                    }
                                }
                            }
                        }
                        if dr | dc != 0 {
                            // Columns of changed rows and rows of changed
                            // columns changed too (the masks are kept in both).
                            let mut t = Touch::default();
                            if !propagate_t(p, g, dr, dc, &mut t) {
                                return Probed::Contradiction;
                            }
                            a.m.copy_from_slice(&g.m);
                            b.m.copy_from_slice(&g.m);
                            memo.changed(p, ta.rows & tb.rows | t.rows, ta.cols & tb.cols | t.cols);
                            progressed = true;
                            if cfg.restart {
                                break 'sweep;
                            }
                            continue;
                        }
                        let (ka, kb) = (ta.newly as u64, tb.newly as u64);
                        let (lo, hi) = (ka.min(kb), ka.max(kb));
                        let score = match cfg.score {
                            0 => lo << 32 | (ka + kb),
                            2 => ka + kb,
                            3 => lo * lo * hi,
                            4 => (ka * kb) << 16 | lo.min(0xFFFF),
                            _ => ka * kb,
                        };
                        memo.cells[r * p.w + c] = (memo.epoch, score, ta.vrows | tb.vrows, ta.vcols | tb.vcols);
                        if !progressed && best.is_none_or(|x| score > x.0) {
                            best = Some((score, r, c));
                        }
                        restore(p, &mut a, g, &ta);
                        restore(p, &mut b, g, &tb);
                    }
                }
            }
        }
        if !progressed {
            break;
        }
    }
    match best {
        None => Probed::Solved,
        Some((_, r, c)) => {
            // Rebuild the two sides of the chosen cell.
            let (ok_a, ta) = probe_side(p, &mut a, r, c, true);
            let (ok_b, tb) = probe_side(p, &mut b, r, c, false);
            debug_assert!(ok_a && ok_b);
            Probed::Branch(a, b, ta.newly as u64, tb.newly as u64, (ta.rows, ta.cols), (tb.rows, tb.cols))
        }
    }
}

/// Branch without probing: the first unknown cell of the line with the
/// fewest unknown cells, both values propagated.
fn cheap_branch(p: &Puzzle, g: &Grid, act: Mask, act_cols: Mask) -> Probed {
    let mut best = (u32::MAX, 0usize, 0 as Mask);
    for line in 0..p.h + p.w {
        let active = if line < p.h { act >> line & 1 } else { act_cols >> (line - p.h) & 1 };
        if active == 0 {
            continue;
        }
        let n = if line < p.h { p.w } else { p.h };
        let unk = ones(n) & !(g.m[2 * line] | g.m[2 * line + 1]);
        let k = unk.count_ones();
        if k != 0 && k < best.0 {
            best = (k, line, unk);
        }
    }
    if best.0 == u32::MAX {
        return Probed::Solved;
    }
    let i = best.2.trailing_zeros() as usize;
    let (r, c) = if best.1 < p.h { (best.1, i) } else { (i, best.1 - p.h) };
    let mut a = g.clone();
    let (ok_a, ta) = probe_side(p, &mut a, r, c, true);
    let mut b = g.clone();
    let (ok_b, tb) = probe_side(p, &mut b, r, c, false);
    match (ok_a, ok_b) {
        (false, false) => Probed::Contradiction,
        // One child: hand it back as a branch whose other side is dead.
        _ => Probed::Branch(
            a,
            b,
            if ok_a { ta.newly as u64 } else { u64::MAX },
            if ok_b { tb.newly as u64 } else { u64::MAX },
            (ta.rows, ta.cols),
            (tb.rows, tb.cols),
        ),
    }
}

// ── Independent parts ───────────────────────────────────────────────────
//
// Two open cells depend on each other only through a shared row or column.
// When the open cells fall into groups that share no line, each group is a
// puzzle of its own: its solutions combine freely with the others'. Solving
// the groups apart turns a product of search trees into a sum. #SAT solvers
// call this component decomposition.

/// The groups of open cells, as (rows, cols) masks, among the given rows.
fn components(p: &Puzzle, g: &Grid, act: Mask) -> Vec<(Mask, Mask)> {
    let n = p.h + p.w;
    let mut parent: [u8; 256] = [0; 256];
    for i in 0..n {
        parent[i] = i as u8;
    }
    fn find(parent: &mut [u8; 256], mut x: usize) -> usize {
        while parent[x] as usize != x {
            parent[x] = parent[parent[x] as usize];
            x = parent[x] as usize;
        }
        x
    }
    let mut rows = act;
    let mut used: Mask = 0;
    while rows != 0 {
        let r = rows.trailing_zeros() as usize;
        rows &= rows - 1;
        let mut unk = ones(p.w) & !(g.m[2 * r] | g.m[2 * r + 1]);
        if unk == 0 {
            continue;
        }
        used |= 1 << r;
        let ra = find(&mut parent, r);
        while unk != 0 {
            let c = unk.trailing_zeros() as usize;
            unk &= unk - 1;
            let cb = find(&mut parent, p.h + c);
            if ra != cb {
                parent[cb] = ra as u8;
            }
        }
    }
    let mut out: Vec<(usize, Mask, Mask)> = Vec::new();
    let mut x = used;
    while x != 0 {
        let r = x.trailing_zeros() as usize;
        x &= x - 1;
        let root = find(&mut parent, r);
        match out.iter_mut().find(|e| e.0 == root) {
            Some(e) => e.1 |= 1 << r,
            None => out.push((root, 1 << r, 0)),
        }
    }
    for c in 0..p.w {
        let root = find(&mut parent, p.h + c);
        if let Some(e) = out.iter_mut().find(|e| e.0 == root) {
            e.2 |= 1 << c;
        }
    }
    out.into_iter().map(|(_, r, c)| (r, c)).collect()
}

/// Copy the lines of one part from `src` into `dst`.
fn take_part(p: &Puzzle, dst: &mut Grid, src: &Grid, part: (Mask, Mask)) {
    for (mut x, base) in [(part.0, 0), (part.1, p.h)] {
        while x != 0 {
            let l = base + x.trailing_zeros() as usize;
            x &= x - 1;
            dst.m[2 * l] = src.m[2 * l];
            dst.m[2 * l + 1] = src.m[2 * l + 1];
        }
    }
}

/// Solve the parts one by one and combine: up to two whole solutions.
fn solve_parts(p: &Puzzle, g: &Grid, parts: &[(Mask, Mask)], depth: u32, sh: &Shared, nodes: &mut u64) -> Vec<Grid> {
    let mut sols: Vec<Vec<Grid>> = Vec::with_capacity(parts.len());
    for &part in parts {
        let s = count(p, g.clone(), part, depth, sh, nodes, ProbeMemo::new(p));
        if s.is_empty() {
            return Vec::new();
        }
        sols.push(s);
    }
    let mut first = g.clone();
    for (part, s) in parts.iter().zip(&sols) {
        take_part(p, &mut first, &s[0], *part);
    }
    let mut out = vec![first];
    if let Some(i) = sols.iter().position(|s| s.len() > 1) {
        let mut second = out[0].clone();
        take_part(p, &mut second, &sols[i][1], parts[i]);
        out.push(second);
    }
    out
}

/// Count up to two solutions of one part on this thread.
fn count(
    p: &Puzzle,
    mut g: Grid,
    part: (Mask, Mask),
    mut depth: u32,
    sh: &Shared,
    nodes: &mut u64,
    mut memo: ProbeMemo,
) -> Vec<Grid> {
    let cfg = config();
    let mut out: Vec<Grid> = Vec::new();
    loop {
        if sh.stop() {
            return out;
        }
        *nodes += 1;
        if (*nodes).is_multiple_of(8) && sh.limit_at.is_some_and(|d| Instant::now() > d) {
            sh.timed_out.store(true, Relaxed);
            return out;
        }
        let probed = if depth < cfg.probe_depth {
            probe(p, &mut g, part.0, &mut memo)
        } else {
            cheap_branch(p, &g, part.0, part.1)
        };
        match probed {
            Probed::Contradiction => return out,
            Probed::Solved => {
                out.push(g);
                return out;
            }
            Probed::Branch(a, b, ka, kb, la, lb) => {
                if cfg.parts {
                    let parts = components(p, &g, part.0);
                    if parts.len() > 1 {
                        let s = solve_parts(p, &g, &parts, depth, sh, nodes);
                        out.extend(s);
                        out.truncate(2);
                        return out;
                    }
                }
                depth += 1;
                match (ka == u64::MAX, kb == u64::MAX) {
                    (false, true) => {
                        g = a;
                        memo.changed(p, la.0, la.1);
                        continue;
                    }
                    (true, false) => {
                        g = b;
                        memo.changed(p, lb.0, lb.1);
                        continue;
                    }
                    _ => {}
                }
                let filled_first = match cfg.order {
                    1 => false,
                    2 => ka >= kb,
                    3 => ka <= kb,
                    _ => true,
                };
                let ((first, lf), (second, ls)) = if filled_first { ((a, la), (b, lb)) } else { ((b, lb), (a, la)) };
                let mut m1 = memo.clone();
                m1.changed(p, lf.0, lf.1);
                memo.changed(p, ls.0, ls.1);
                let s = count(p, first, part, depth, sh, nodes, m1);
                out.extend(s);
                if out.len() >= 2 {
                    out.truncate(2);
                    return out;
                }
                g = second;
            }
        }
    }
}

pub static FLOW_DEAD: AtomicU64 = AtomicU64::new(0);
pub static CUBES: AtomicU64 = AtomicU64::new(0);
pub static FLOW_FORCED: AtomicU64 = AtomicU64::new(0);

/// Run the count check on a grid: what each row and column still needs,
/// and which cells are open.
fn flow_check(p: &Puzzle, g: &Grid) -> Option<Vec<(usize, usize, bool)>> {
    let need = |l: usize| p.clue(l).iter().sum::<u32>() - g.m[2 * l].count_ones();
    let rn: Vec<u32> = (0..p.h).map(need).collect();
    let cn: Vec<u32> = (0..p.w).map(|c| need(p.h + c)).collect();
    let open: Vec<Mask> = (0..p.h).map(|r| ones(p.w) & !(g.m[2 * r] | g.m[2 * r + 1])).collect();
    crate::flow::propagate(p.h, p.w, &rn, &cn, &open)
}

/// What the search threads share.
struct Shared {
    limit: usize,
    found: AtomicUsize,
    sols: Mutex<Vec<Grid>>,
    nodes: AtomicU64,
    /// Subtrees waiting for a thread, and the signal that one arrived.
    queue: Mutex<Vec<(Grid, u32)>>,
    ready: Condvar,
    /// Threads waiting for work. A searching thread gives away its second
    /// branch only while this is above zero, so subtrees move between
    /// threads only when a thread would otherwise sit idle.
    idle: AtomicUsize,
    /// Subtrees queued or being searched. Zero means the search is done.
    pending: AtomicUsize,
    parallel: bool,
    /// The single-thread attempt gives up at this time.
    deadline: Option<Instant>,
    aborted: AtomicBool,
    /// The whole solve gives up at this time.
    limit_at: Option<Instant>,
    timed_out: AtomicBool,
    /// Set when another engine of the portfolio has finished.
    cancel: Option<Arc<AtomicBool>>,
    /// Probing threads allowed to run; the portfolio lowers it to move
    /// cores to the learning solver. Threads above it hand their work
    /// back and leave.
    quota: Arc<AtomicUsize>,
    active: AtomicUsize,
    facts: Option<Arc<Facts>>,
    /// Cube-and-conquer depth for this search (0 = off).
    cube_depth: u32,
}

impl Shared {
    fn new(parallel: bool, deadline: Option<Instant>, limit_at: Option<Instant>) -> Shared {
        Shared {
            limit: 2,
            found: AtomicUsize::new(0),
            sols: Mutex::new(Vec::new()),
            nodes: AtomicU64::new(0),
            queue: Mutex::new(Vec::new()),
            ready: Condvar::new(),
            idle: AtomicUsize::new(0),
            pending: AtomicUsize::new(0),
            parallel,
            deadline,
            aborted: AtomicBool::new(false),
            limit_at,
            timed_out: AtomicBool::new(false),
            cancel: None,
            quota: Arc::new(AtomicUsize::new(usize::MAX)),
            active: AtomicUsize::new(0),
            facts: None,
            cube_depth: config().cube_depth,
        }
    }

    #[inline(always)]
    fn stop(&self) -> bool {
        self.found.load(Relaxed) >= self.limit
            || self.aborted.load(Relaxed)
            || self.timed_out.load(Relaxed)
            || self.cancel.as_ref().is_some_and(|c| c.load(Relaxed))
    }

    fn record(&self, g: Grid) {
        let mut s = self.sols.lock().unwrap();
        if s.len() < self.limit {
            s.push(g);
        }
        self.found.store(s.len(), Relaxed);
        if s.len() >= self.limit {
            drop(s);
            let _q = self.queue.lock().unwrap();
            self.ready.notify_all();
        }
    }

    fn give(&self, g: Grid, depth: u32) {
        self.pending.fetch_add(1, SeqCst);
        self.queue.lock().unwrap().push((g, depth));
        self.ready.notify_one();
    }
}

fn dfs(p: &Puzzle, mut g: Grid, mut depth: u32, sh: &Shared, nodes: &mut u64, mut memo: ProbeMemo) {
    let cfg = config();
    let mut seen_facts = u64::MAX;
    loop {
        if sh.stop() {
            return;
        }
        if sh.parallel && sh.active.load(Relaxed) > sh.quota.load(Relaxed) {
            sh.give(g, depth);
            return;
        }
        *nodes += 1;
        if (*nodes).is_multiple_of(8) {
            let now = Instant::now();
            if sh.deadline.is_some_and(|d| now > d) {
                sh.aborted.store(true, Relaxed);
                return;
            }
            if sh.limit_at.is_some_and(|d| now > d) {
                sh.timed_out.store(true, Relaxed);
                return;
            }
        }
        if let Some(f) = &sh.facts {
            if f.version() != seen_facts {
                let (v, m) = f.snapshot();
                seen_facts = v;
                let (mut dr, mut dc) = (0 as Mask, 0 as Mask);
                for l in 0..p.h + p.w {
                    for o in 0..2 {
                        let add = m[2 * l + o] & !g.m[2 * l + o];
                        if add != 0 {
                            g.m[2 * l + o] |= add;
                            if l < p.h {
                                dr |= 1 << l
                            } else {
                                dc |= 1 << (l - p.h)
                            }
                        }
                    }
                }
                if dr | dc != 0 {
                    let mut t = Touch::default();
                    if !propagate_t(p, &mut g, dr, dc, &mut t) {
                        return;
                    }
                    memo.changed(p, dr | t.rows, dc | t.cols);
                }
            }
        }
        let probed = if depth < cfg.probe_depth {
            probe(p, &mut g, ones(p.h), &mut memo)
        } else {
            cheap_branch(p, &g, ones(p.h), ones(p.w))
        };
        // Cube-and-conquer: below `cube_depth` the probing search stops
        // splitting and hands the probed partial grid (a "cube") to a
        // learning solver. Probing picks good split cells; learning finishes
        // the parts. Cubes cover disjoint parts of the search, so their
        // solutions add up for the uniqueness check, and the probing threads
        // already share subtrees, so cubes run in parallel.
        if sh.cube_depth > 0 && depth >= sh.cube_depth && matches!(probed, Probed::Branch(..)) {
            let o = crate::cdcl::solve(p, Some(&g), sh.limit_at, sh.cancel.as_deref(), cfg.cube_seed, None);
            CUBES.fetch_add(1, Relaxed);
            if o.timed_out {
                sh.timed_out.store(true, Relaxed);
            }
            for sol in o.solutions {
                sh.record(sol);
            }
            return;
        }
        // The global count check (crate::flow) on the probed state: a dead
        // branch, or cells forced by all rows and columns together.
        if cfg.flow && matches!(probed, Probed::Branch(..)) {
            match flow_check(p, &g) {
                None => {
                    FLOW_DEAD.fetch_add(1, Relaxed);
                    return;
                }
                Some(forced) if !forced.is_empty() => {
                    FLOW_FORCED.fetch_add(forced.len() as u64, Relaxed);
                    let (mut dr, mut dc) = (0 as Mask, 0 as Mask);
                    for (r, c, fill) in forced {
                        g.set(p, r, c, fill);
                        dr |= 1 << r;
                        dc |= 1 << c;
                    }
                    let mut t = Touch::default();
                    if !propagate_t(p, &mut g, dr, dc, &mut t) {
                        return;
                    }
                    memo.changed(p, dr | t.rows, dc | t.cols);
                    continue;
                }
                _ => {}
            }
        }
        if depth == 0 {
            if let (Some(f), Probed::Branch(..)) = (&sh.facts, &probed) {
                f.publish(&g);
            }
        }
        match probed {
            Probed::Contradiction => return,
            Probed::Solved => {
                sh.record(g);
                return;
            }
            Probed::Branch(a, b, ka, kb, la, lb) => {
                if cfg.parts {
                    let parts = components(p, &g, ones(p.h));
                    if parts.len() > 1 {
                        for s in solve_parts(p, &g, &parts, depth, sh, nodes) {
                            sh.record(s);
                        }
                        return;
                    }
                }
                depth += 1;
                // A gain of u64::MAX marks a dead child (cheap_branch only).
                match (ka == u64::MAX, kb == u64::MAX) {
                    (false, true) => {
                        g = a;
                        memo.changed(p, la.0, la.1);
                        continue;
                    }
                    (true, false) => {
                        g = b;
                        memo.changed(p, lb.0, lb.1);
                        continue;
                    }
                    _ => {}
                }
                let filled_first = match cfg.order {
                    1 => false,
                    2 => ka >= kb,
                    3 => ka <= kb,
                    _ => true,
                };
                let ((first, lf), (second, ls)) = if filled_first { ((a, la), (b, lb)) } else { ((b, lb), (a, la)) };
                if sh.parallel && sh.idle.load(Relaxed) > 0 {
                    // The other thread starts with a fresh memo.
                    sh.give(second, depth);
                    memo.changed(p, lf.0, lf.1);
                    g = first;
                } else {
                    let mut m1 = memo.clone();
                    m1.changed(p, lf.0, lf.1);
                    dfs(p, first, depth, sh, nodes, m1);
                    memo.changed(p, ls.0, ls.1);
                    g = second;
                }
            }
        }
    }
}

fn worker(p: &Puzzle, sh: &Shared) {
    let mut nodes = 0;
    sh.active.fetch_add(1, SeqCst);
    loop {
        // Over the quota: leave (one thread at a time).
        let a = sh.active.load(SeqCst);
        if a > sh.quota.load(SeqCst) && sh.active.compare_exchange(a, a - 1, SeqCst, SeqCst).is_ok() {
            sh.nodes.fetch_add(nodes, Relaxed);
            let _q = sh.queue.lock().unwrap();
            sh.ready.notify_all();
            return;
        }
        let task = {
            let mut q = sh.queue.lock().unwrap();
            loop {
                if sh.stop() {
                    break None;
                }
                if let Some(t) = q.pop() {
                    break Some(t);
                }
                if sh.pending.load(SeqCst) == 0 {
                    break None;
                }
                sh.idle.fetch_add(1, SeqCst);
                // Timed: a stop from another engine of the portfolio
                // does not signal this condition variable.
                q = sh.ready.wait_timeout(q, Duration::from_millis(1)).unwrap().0;
                sh.idle.fetch_sub(1, SeqCst);
            }
        };
        let Some((t, depth)) = task else { break };
        dfs(p, t, depth, sh, &mut nodes, ProbeMemo::new(p));
        if sh.pending.fetch_sub(1, SeqCst) == 1 {
            // The last subtree is done: wake everyone so they can leave.
            let _q = sh.queue.lock().unwrap();
            sh.ready.notify_all();
        }
    }
    sh.active.fetch_sub(1, SeqCst);
    sh.nodes.fetch_add(nodes, Relaxed);
}

#[derive(Default)]
pub struct Outcome {
    /// Up to two solutions: two means the puzzle is not unique.
    pub solutions: Vec<Grid>,
    /// The time limit ran out first; `solutions` is then incomplete.
    pub timed_out: bool,
    /// Another engine of the portfolio finished first.
    pub cancelled: bool,
    pub nodes: u64,
    pub threads_used: usize,
    /// Which engine produced the answer: line logic, the probing search, or
    /// a learning strategy.
    pub engine: String,
    /// Cells settled by line logic alone, before any search.
    pub root_known: u32,
    /// Learning-solver statistics when a learning thread won.
    pub conflicts: u64,
    pub restarts: u64,
}

/// Solve, counting up to two solutions. `threads` 0 means all cores.
pub fn solve(p: &Puzzle, threads: usize) -> Outcome {
    solve_within(p, threads, None)
}

/// As `solve`, giving up after `limit`.
/// One engine on the calling thread, with no threads and no clock: for WebAssembly, where
/// a page races several of these in separate workers and ends the losers itself.
/// `engine` 0 is the probing search; `engine` n >= 1 is the learning solver with
/// strategy n - 1 (1: cells only, 2: block-position variables, 4: a perturbed copy of 2).
pub fn solve_engine(p: &Puzzle, engine: u32) -> Outcome {
    let mut g = Grid { m: vec![0; 2 * (p.h + p.w)] };
    let mut out = Outcome { threads_used: 1, engine: "line logic".into(), ..Default::default() };
    if !propagate(p, &mut g, ones(p.h), ones(p.w)) {
        return out;
    }
    let root_known: u32 = (0..p.h).map(|r| (g.m[2 * r] | g.m[2 * r + 1]).count_ones()).sum();
    out.root_known = root_known;
    if g.solved(p) {
        out.solutions.push(g);
        return out;
    }
    let mut result = if engine == 0 {
        search(p, g, 1, None, None, None, None, None)
    } else {
        let seed = (engine - 1) as u64;
        let mut o = from_cdcl(crate::cdcl::solve(p, Some(&g), None, None, seed, None));
        o.engine = format!("learning solver, strategy {seed}");
        o
    };
    result.root_known = root_known;
    result
}

pub fn solve_within(p: &Puzzle, threads: usize, limit: Option<Duration>) -> Outcome {
    let start = Instant::now();
    let limit_at = limit.map(|l| start + l);
    let lines = p.h + p.w;
    let mut g = Grid { m: vec![0; 2 * lines] };
    let mut out = Outcome { threads_used: 1, engine: "line logic".into(), ..Default::default() };
    if !propagate(p, &mut g, ones(p.h), ones(p.w)) {
        return out;
    }
    let root_known: u32 = (0..p.h).map(|r| (g.m[2 * r] | g.m[2 * r + 1]).count_ones()).sum();
    out.root_known = root_known;
    if g.solved(p) {
        out.solutions.push(g);
        return out;
    }
    let threads = if threads == 0 { std::thread::available_parallelism().map_or(1, |n| n.get()) } else { threads };
    let engine = match config().engine {
        0 if threads < 2 => 1,
        e => e,
    };
    let mut result = match engine {
        1 => search(p, g, threads, limit_at, None, None, None, None),
        2 => from_cdcl(crate::cdcl::solve(p, Some(&g), limit_at, None, 0, None)),
        _ => {
            // Portfolio: the first engine to finish sets the flag, which
            // stops the others. `cdcl_threads` learning solvers with
            // different seeds; the probing search gets the other threads,
            // on this thread. The others are detached: this returns as soon
            // as there is a winner instead of waiting for an engine still
            // in its setup (strategy 1 builds its encoding for ~17 ms on
            // Center, which a joined scope added to every answer).
            let cfg = config();
            // At least one thread for the probing search when there are two
            // or more.
            let k = cfg.cdcl_threads.min(threads - 1).max(1);
            let dfs_threads = threads - k;
            let stop = Arc::new(AtomicBool::new(false));
            let quota = Arc::new(AtomicUsize::new(usize::MAX));
            let facts = cfg.share.then(|| Arc::new(Facts::new(p)));
            let fastest = fastest_cpu();
            let pa = Arc::new(p.clone());
            let race = Arc::new(Race::default());
            for i in 0..k {
                // Threads beyond the first two retire after `retire_ms`: a
                // wide start finds quick answers, and fewer busy cores keep
                // the clock up for the long-running engines (Faase took
                // 125 s with 3 busy threads, 229 s with 7).
                let lim = if i >= 2 && cfg.retire_ms > 0 {
                    let r = Instant::now() + Duration::from_millis(cfg.retire_ms);
                    Some(limit_at.map_or(r, |l| l.min(r)))
                } else {
                    limit_at
                };
                spawn_cdcl(&pa, &g, lim, &stop, &race, seed_of(i), i == 0 && cfg.pin, fastest, &facts);
            }
            // After `grow_ms` without an answer, cores move from the
            // probing search to more learning threads.
            if (cfg.grow_to > k || cfg.grow_dfs < dfs_threads) && dfs_threads > 0 {
                let (pa3, stop3, quota3, g3, race3, f3) =
                    (pa.clone(), stop.clone(), quota.clone(), g.clone(), race.clone(), facts.clone());
                let extra = cfg.grow_to.saturating_sub(k).min(dfs_threads);
                let dfs_after = (dfs_threads - extra).min(cfg.grow_dfs);
                race.enter();
                std::thread::spawn(move || {
                    let until = Instant::now() + Duration::from_millis(cfg.grow_ms);
                    while Instant::now() < until {
                        if stop3.load(Relaxed) {
                            race3.finish(None);
                            return;
                        }
                        std::thread::sleep(Duration::from_millis(1));
                    }
                    quota3.store(dfs_after, SeqCst);
                    for i in k..k + extra {
                        spawn_cdcl(&pa3, &g3, limit_at, &stop3, &race3, seed_of(i), false, None, &f3);
                    }
                    // A cube-and-conquer arm on cores the switch left idle.
                    if cfg.cube_arm > 0 {
                        let (pa5, stop5, g5, f5, race5) =
                            (pa3.clone(), stop3.clone(), g3.clone(), f3.clone(), race3.clone());
                        race3.enter();
                        std::thread::spawn(move || {
                            let mut o = search(
                                &pa5,
                                g5,
                                cfg.cube_arm,
                                limit_at,
                                Some(stop5.clone()),
                                None,
                                f5,
                                Some(cfg.cube_arm_depth),
                            );
                            let won = !o.timed_out && !o.cancelled && !stop5.swap(true, SeqCst);
                            o.engine = format!("cube-and-conquer, depth {}", cfg.cube_arm_depth);
                            race5.finish(won.then_some(o));
                        });
                    }
                    race3.finish(None);
                });
            }
            if dfs_threads > 0 {
                let o = search(
                    p,
                    g.clone(),
                    dfs_threads,
                    limit_at,
                    Some(stop.clone()),
                    Some(quota.clone()),
                    facts.clone(),
                    None,
                );
                if !o.timed_out && !o.cancelled && !stop.swap(true, SeqCst) {
                    race.win(o);
                }
            }
            let o = race.wait();
            stop.store(true, SeqCst);
            let mut o = o.unwrap_or(Outcome { timed_out: true, ..Default::default() });
            o.threads_used = threads;
            o
        }
    };
    result.root_known = root_known;
    result
}

/// The strategy of learning thread `i`, in order: NONO_SEEDS, by default
/// 1, 0, 3, 5 (strategy 1, strategy 0, then two perturbed copies of
/// strategy 1 that retire after `retire_ms`), then thread i runs strategy i.
///
/// Measured 2026-10-09 against the old portfolio (strategy 0 and the
/// probing search, strategy 1 after 1 s): survey hard puzzles, 10 runs,
/// geomean of medians 94.8 against 104.9 ms (9-Dom 58 against 82 ms,
/// Gettys 2.5 against 4.0 s, Thing 610 against 503 ms); hard random set
/// 19/20 both, PAR-2 103 against 119 s; Knotty 20.7 s and Faase 127.5 s,
/// level. Without retiring, the extra threads slowed strategy 0 on the
/// long puzzles (Faase 160-229 s): more busy cores, lower clocks.
fn seed_of(i: usize) -> usize {
    static S: std::sync::OnceLock<Vec<usize>> = std::sync::OnceLock::new();
    let s = S.get_or_init(|| {
        std::env::var("NONO_SEEDS")
            .map_or(vec![1, 0, 3, 5], |v| v.split(',').filter_map(|x| x.trim().parse().ok()).collect())
    });
    s.get(i).copied().unwrap_or(i)
}

/// The portfolio's meeting point: the first winner, and how many detached
/// engines are still running.
#[derive(Default)]
struct Race {
    state: Mutex<(Option<Outcome>, usize)>,
    cv: Condvar,
}

/// Engine threads still running, across portfolios: `quiesce` waits for
/// them, so a batch run does not start a puzzle while the previous
/// puzzle's engines are still winding down.
static LIVE: AtomicUsize = AtomicUsize::new(0);

/// Wait until no engine thread of an earlier `solve` is left.
pub fn quiesce() {
    while LIVE.load(SeqCst) > 0 {
        std::thread::sleep(Duration::from_micros(200));
    }
}

impl Race {
    fn enter(&self) {
        LIVE.fetch_add(1, SeqCst);
        self.state.lock().unwrap().1 += 1;
    }

    fn win(&self, o: Outcome) {
        let mut st = self.state.lock().unwrap();
        st.0.get_or_insert(o);
        self.cv.notify_all();
    }

    /// An engine ends, with its outcome if it won.
    fn finish(&self, o: Option<Outcome>) {
        let mut st = self.state.lock().unwrap();
        if let Some(o) = o {
            st.0.get_or_insert(o);
        }
        st.1 -= 1;
        self.cv.notify_all();
        drop(st);
        LIVE.fetch_sub(1, SeqCst);
    }

    /// The winner, or None once every engine has ended without one.
    fn wait(&self) -> Option<Outcome> {
        let mut st = self.state.lock().unwrap();
        while st.0.is_none() && st.1 > 0 {
            st = self.cv.wait(st).unwrap();
        }
        st.0.take()
    }
}

#[allow(clippy::too_many_arguments)]
fn spawn_cdcl(
    p: &Arc<Puzzle>,
    g: &Grid,
    limit_at: Option<Instant>,
    stop: &Arc<AtomicBool>,
    race: &Arc<Race>,
    seed: usize,
    pin: bool,
    cpu: Option<usize>,
    facts: &Option<Arc<Facts>>,
) {
    let (p, g, stop, race, facts) = (p.clone(), g.clone(), stop.clone(), race.clone(), facts.clone());
    race.enter();
    std::thread::spawn(move || {
        let o = run_cdcl(&p, &g, limit_at, &stop, seed, pin, cpu, facts);
        race.finish(o);
    });
}

#[allow(clippy::too_many_arguments)]
fn run_cdcl(
    p: &Puzzle,
    g: &Grid,
    limit_at: Option<Instant>,
    stop: &AtomicBool,
    seed: usize,
    pin: bool,
    cpu: Option<usize>,
    facts: Option<Arc<Facts>>,
) -> Option<Outcome> {
    if pin {
        if let Some(c) = cpu {
            pin_to(c);
        }
    }
    let o = crate::cdcl::solve(p, Some(g), limit_at, Some(stop), seed as u64, facts.as_deref());
    if !o.cancelled && !o.timed_out && !stop.swap(true, SeqCst) {
        let mut o = from_cdcl(o);
        o.engine = format!("learning solver, strategy {seed}");
        return Some(o);
    }
    None
}

/// The core with the highest maximum clock (on a hybrid CPU, a performance
/// core), from the kernel's cpufreq table. None where that is unavailable.
fn fastest_cpu() -> Option<usize> {
    static F: std::sync::OnceLock<Option<usize>> = std::sync::OnceLock::new();
    *F.get_or_init(|| {
        let n = std::thread::available_parallelism().map_or(1, |n| n.get());
        (0..n)
            .filter_map(|c| {
                let f =
                    std::fs::read_to_string(format!("/sys/devices/system/cpu/cpu{c}/cpufreq/cpuinfo_max_freq")).ok()?;
                Some((f.trim().parse::<u64>().ok()?, c))
            })
            .max_by_key(|&(f, c)| (f, std::cmp::Reverse(c)))
            .map(|(_, c)| c)
    })
}

#[cfg(target_os = "linux")]
fn pin_to(cpu: usize) {
    extern "C" {
        fn sched_setaffinity(pid: i32, cpusetsize: usize, mask: *const u64) -> i32;
    }
    let mut mask = [0u64; 16];
    if cpu < 1024 {
        mask[cpu / 64] |= 1 << (cpu % 64);
        // SAFETY: a valid cpu_set_t-sized mask for the calling thread (pid 0).
        unsafe { sched_setaffinity(0, std::mem::size_of_val(&mask), mask.as_ptr()) };
    }
}

#[cfg(not(target_os = "linux"))]
fn pin_to(_cpu: usize) {}

fn from_cdcl(c: crate::cdcl::Outcome) -> Outcome {
    Outcome {
        solutions: c.solutions,
        timed_out: c.timed_out,
        cancelled: c.cancelled,
        nodes: c.stats.decisions,
        threads_used: 1,
        engine: "learning solver".into(),
        conflicts: c.stats.conflicts,
        restarts: c.stats.restarts,
        ..Default::default()
    }
}

/// The probing search: one thread for the solo phase, then all of them.
#[allow(clippy::too_many_arguments)]
fn search(
    p: &Puzzle,
    g: Grid,
    threads: usize,
    limit_at: Option<Instant>,
    cancel: Option<Arc<AtomicBool>>,
    quota: Option<Arc<AtomicUsize>>,
    facts: Option<Arc<Facts>>,
    cube_depth: Option<u32>,
) -> Outcome {
    let mut out = Outcome { threads_used: 1, engine: "probing search".into(), ..Default::default() };
    let cancelled = |c: &Option<Arc<AtomicBool>>| c.as_ref().is_some_and(|c| c.load(Relaxed));
    let solo_for = Duration::from_micros(config().solo_us);
    let mut solo = Shared::new(false, (threads > 1).then(|| Instant::now() + solo_for), limit_at);
    solo.cancel = cancel.clone();
    solo.facts = facts.clone();
    if let Some(d) = cube_depth {
        solo.cube_depth = d;
    }
    let mut nodes = 0;
    dfs(p, g.clone(), 0, &solo, &mut nodes, ProbeMemo::new(p));
    if !solo.aborted.load(Relaxed) {
        out.timed_out = solo.timed_out.load(Relaxed);
        out.cancelled = !out.timed_out && cancelled(&cancel) && solo.found.load(Relaxed) < 2;
        out.solutions = solo.sols.into_inner().unwrap();
        out.nodes = nodes;
        return out;
    }

    // Still searching after the solo phase: start again on every core.
    let mut sh = Shared::new(true, None, limit_at);
    sh.cancel = cancel.clone();
    sh.facts = facts.clone();
    if let Some(d) = cube_depth {
        sh.cube_depth = d;
    }
    if let Some(q) = quota {
        sh.quota = q;
    }
    sh.nodes.store(nodes, Relaxed);
    sh.give(g, 0);
    std::thread::scope(|s| {
        for _ in 0..threads {
            s.spawn(|| worker(p, &sh));
        }
    });
    out.nodes = sh.nodes.load(Relaxed);
    out.timed_out = sh.timed_out.load(Relaxed);
    // Work still queued means the search did not finish: stopped by the
    // other engine, or every thread handed its work back when the
    // portfolio moved cores away. Either way the result is incomplete and
    // must not win the race (it once reported "no solution" for Gettys).
    out.cancelled = !out.timed_out && sh.found.load(Relaxed) < 2 && (sh.pending.load(SeqCst) > 0 || cancelled(&cancel));
    out.solutions = sh.sols.into_inner().unwrap();
    out.threads_used = threads;
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A probing search whose threads all leave (quota 0) is incomplete,
    /// never "no solution".
    #[test]
    fn a_search_without_threads_is_incomplete() {
        // The 2×2 diagonal has two solutions and needs a branch.
        let p = Puzzle::new(&[vec![1], vec![1]], &[vec![1], vec![1]]);
        let mut g = Grid { m: vec![0; 8] };
        assert!(propagate(&p, &mut g, ones(2), ones(2)));
        let quota = Arc::new(AtomicUsize::new(0));
        let o = search(&p, g, 2, None, None, Some(quota), None, None);
        assert!(
            o.cancelled || o.solutions.len() == 2,
            "found {} solutions, cancelled {}",
            o.solutions.len(),
            o.cancelled
        );
    }
}
