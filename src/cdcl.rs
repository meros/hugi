//! Lazy clause generation: the line solver plus SAT-style learning.
//!
//! The search state is a trail of cell assignments, each with a decision
//! level and a reason. Propagation runs learned clauses first (two watched
//! literals, as in SAT solvers) and then the bit-parallel line solver on the
//! lines that changed. A line that forces a cell records only *that* it did.
//! The reason is worked out when conflict analysis needs it: the cells of
//! that line known before the forced cell, shrunk while the line solver still
//! forces the same value. A line that has no placement left yields a conflict
//! clause the same way.
//!
//! On a conflict the solver derives a first-UIP clause, minimises it, jumps
//! back to the level where the clause asserts its last literal, and adds the
//! clause, so the same combination of cells is never tried again anywhere in
//! the search. Variables are chosen by VSIDS activity with saved phases;
//! restarts follow the Luby sequence; learned clauses with a high LBD are
//! deleted periodically.
//!
//! Uniqueness: after the first solution the solver adds a clause forbidding
//! that solution's decisions and carries on. The decisions plus propagation
//! fix every cell, so the clause excludes exactly that one solution.

use crate::clock::Instant;
use crate::line::{ones, Mask};
use crate::solver::{self, Grid, Puzzle};
use std::sync::atomic::{AtomicBool, Ordering::Relaxed};

type Lit = u32;

#[inline(always)]
fn var(l: Lit) -> usize {
    (l >> 1) as usize
}

/// The literal "cell v is filled" (or "empty" when `empty`).
#[inline(always)]
fn lit(v: usize, empty: bool) -> Lit {
    (v as u32) << 1 | empty as u32
}

const UNDEF: u8 = 2;

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Reason {
    Decision,
    /// Forced by the line solver on this line (rows first, then columns).
    Line(u32),
    /// Forced by this clause.
    Clause(u32),
    /// Forced by the ladder (`ladder_step`) through the two-literal clause
    /// whose other literal, false, is this one.
    Implied(Lit),
}

// Clauses live in one arena of u32: [len, flags, lit0, lit1, ...]. A
// clause reference is its offset. Watches and clause bodies then sit in a
// few contiguous arrays instead of one heap object per clause, which is what
// clause propagation spends its time walking. Flags: LBD in the low 27 bits,
// bit 27 vivified, bits 28-29 a use counter (clause tiers), bit 30 learnt, bit 31 deleted.
const LEARNT: u32 = 1 << 30;
/// In a watch: the clause is binary and `blocker` is its other literal, so
/// propagation never reads the arena for it. Most order-encoding clauses
/// are binary.
const BIN: u32 = 1 << 31;
const DELETED: u32 = 1 << 31;
const LBD_MASK: u32 = (1 << 27) - 1;
/// The clause was vivified already.
const VIVIFIED: u32 = 1 << 27;
const USED_ONE: u32 = 1 << 28;
const USED_MASK: u32 = 3 << 28;

const EXPL_CACHE_BITS: u32 = 16;

#[derive(Clone, Copy)]
struct ExplEntry {
    line: u32,
    /// Position << 1 | empty, or u32::MAX for a line conflict.
    goal: u32,
    f: Mask,
    e: Mask,
    rf: Mask,
    re: Mask,
}

#[derive(Clone, Copy)]
struct Watch {
    cref: u32,
    blocker: Lit,
}

pub struct Stats {
    /// Time to the first solution, and nanoseconds spent building
    /// explanations, in conflict analysis (explanations included) and in
    /// propagation. Read with --cdcl; cheap enough to keep on.
    pub first_solution_ns: u64,
    pub explain_ns: u64,
    pub analyze_ns: u64,
    pub propagate_ns: u64,
    pub learnt_lits: u64,
    pub conflicts: u64,
    pub decisions: u64,
    pub propagations: u64,
    pub explanations: u64,
    pub explain_hits: u64,
    pub root_probes: u64,
    pub imported: u64,
    pub restarts: u64,
    /// Literals removed by shrinking.
    pub shrunk: u64,
    /// Learned clauses shortened by vivification, and literals removed.
    pub vivified: u64,
    pub vivified_lits: u64,
}

pub struct Outcome {
    pub solutions: Vec<Grid>,
    pub timed_out: bool,
    /// Another engine finished first; `solutions` is incomplete.
    pub cancelled: bool,
    pub stats: Stats,
}

enum Conflict {
    Clause(u32),
    Line(u32),
    /// A ladder clause of these two literals, both false.
    Pair(Lit, Lit),
}

struct Solver<'a> {
    p: &'a Puzzle,
    h: usize,
    w: usize,
    nv: usize,
    /// Cells are variables 0..ncell; the order encoding's block-position
    /// and cover variables follow.
    ncell: usize,
    /// Run the line propagator (off: clauses only, a plain SAT solver).
    lines: bool,
    /// Per line: known filled and known empty cells (rows, then columns).
    f: Vec<Mask>,
    e: Vec<Mask>,
    /// Per variable: value (0 filled, 1 empty, UNDEF), level, trail position, reason.
    val: Vec<u8>,
    /// Value per literal (1 true, 0 false, UNDEF), so a literal test is one
    /// load: `lit_val` was 15 % of clause propagation.
    lv: Vec<u8>,
    level: Vec<u32>,
    pos: Vec<u32>,
    reason: Vec<Reason>,
    trail: Vec<Lit>,
    trail_lim: Vec<usize>,
    qhead: usize,
    dirty_rows: Mask,
    dirty_cols: Mask,
    arena: Vec<u32>,
    /// Learned clauses alive, and arena words held by deleted clauses.
    learnts: Vec<u32>,
    garbage: usize,
    /// Reused buffer for reason literals in conflict analysis.
    tmp: Vec<Lit>,
    tmp2: Vec<Lit>,
    stack: Vec<Lit>,
    watches: Vec<Vec<Watch>>,
    /// Cached explanations of line-forced literals, valid while assigned,
    /// and the variables that have one.
    expl: Vec<Option<Vec<Lit>>>,
    expl_vars: Vec<u32>,
    // VSIDS
    activity: Vec<f64>,
    var_inc: f64,
    heap: Vec<u32>,
    heap_pos: Vec<i32>,
    phase: Vec<u8>,
    /// kissat-style phases: the values of the longest conflict-free trail
    /// since the last reset (target) and over the whole run (best), and the
    /// initial phases (original), for rephasing.
    target: Vec<u8>,
    target_size: usize,
    best: Vec<u8>,
    best_size: usize,
    original: Vec<u8>,
    /// Stable mode: rare restarts, decisions follow the target phases.
    stable: bool,
    /// Targets from the consistent trail only (the kissat way; strategy 2).
    /// Strategy 0 keeps the whole trail, which measured 2x better on Gettys.
    consistent_targets: bool,
    /// Conflict analysis marks: 1 in the learned clause or proven
    /// redundant, 3 proven not redundant (minimisation).
    seen: Vec<u8>,
    /// LBD without allocation: the clock value last stamped on each level.
    lbd_stamp: Vec<u64>,
    lbd_clock: u64,
    /// Shrinking: the clock value last stamped on each variable.
    shrink_stamp: Vec<u32>,
    shrink_clock: u32,
    /// Stack for `removable`: variable and position in its reason.
    dfs: Vec<(usize, usize)>,
    /// The ladder, when the solver applies it (NONO_LADDER): the blocks,
    /// and per variable its block (u32::MAX for none); per block the
    /// previous block of its line.
    blocks: Vec<crate::cnf::Block>,
    yblock: Vec<u32>,
    yprev: Vec<u32>,
    ladder_on: bool,
    /// Bounds mode (NONO_BOUNDS): no clauses between cells and block
    /// starts; the line propagator works on both. Per line its first block;
    /// per block its line and the start literals now true and false (bit p
    /// for y(j,p)).
    bounds: bool,
    line_first: Vec<u32>,
    block_line: Vec<u32>,
    ytrue: Vec<Mask>,
    yfalse: Vec<Mask>,
    /// The clause under vivification: propagation leaves it out.
    ignore: u32,
    /// Vivification derived the empty clause.
    unsat: bool,
    /// VSIDS decay factor, shrinking, and learned clauses vivified per
    /// round (per strategy, see `solve`).
    decay: f64,
    shrink: bool,
    vivify_n: usize,
    /// Minimisation: 0 plain, 1 caches failures, 2 also tests levels
    /// first, 3 depth-first search that records every result (`removable`).
    minimise: u8,
    expl_cache: Vec<ExplEntry>,
    stats: Stats,
}

impl<'a> Solver<'a> {
    fn new(p: &'a Puzzle, nv_total: usize) -> Solver<'a> {
        let (h, w) = (p.h, p.w);
        let nv = nv_total.max(h * w);
        let mut s = Solver {
            p,
            h,
            w,
            nv,
            ncell: h * w,
            lines: true,
            f: vec![0; h + w],
            e: vec![0; h + w],
            val: vec![UNDEF; nv],
            lv: vec![UNDEF; 2 * nv],
            level: vec![0; nv],
            pos: vec![0; nv],
            reason: vec![Reason::Decision; nv],
            trail: Vec::with_capacity(nv),
            trail_lim: Vec::new(),
            qhead: 0,
            dirty_rows: ones(h),
            dirty_cols: ones(w),
            arena: Vec::new(),
            learnts: Vec::new(),
            garbage: 0,
            tmp: Vec::new(),
            tmp2: Vec::new(),
            stack: Vec::new(),
            watches: vec![Vec::new(); 2 * nv],
            expl: vec![None; nv],
            expl_vars: Vec::new(),
            activity: vec![0.0; nv],
            var_inc: 1.0,
            heap: Vec::with_capacity(nv),
            heap_pos: vec![-1; nv],
            phase: vec![1; nv],
            target: vec![UNDEF; nv],
            target_size: 0,
            best: vec![UNDEF; nv],
            best_size: 0,
            original: Vec::new(),
            stable: false,
            consistent_targets: false,
            seen: vec![0; nv],
            lbd_stamp: vec![0; nv + 1],
            lbd_clock: 0,
            shrink_stamp: vec![0; nv],
            shrink_clock: 0,
            dfs: Vec::new(),
            blocks: Vec::new(),
            yblock: Vec::new(),
            yprev: Vec::new(),
            ladder_on: false,
            bounds: false,
            line_first: Vec::new(),
            block_line: Vec::new(),
            ytrue: Vec::new(),
            yfalse: Vec::new(),
            ignore: u32::MAX,
            unsat: false,
            decay: 0.95,
            shrink: false,
            vivify_n: 0,
            // Level 1 learns exactly the clauses of level 0. Level 2 was the
            // default for strategy 0 for a day: sound, but it changes which
            // explanations get built, and Knotty went from 23 s to over 600 s.
            minimise: 1,
            expl_cache: vec![ExplEntry { line: u32::MAX, goal: 0, f: 0, e: 0, rf: 0, re: 0 }; 1 << EXPL_CACHE_BITS],
            stats: Stats {
                first_solution_ns: 0,
                explain_ns: 0,
                analyze_ns: 0,
                propagate_ns: 0,
                learnt_lits: 0,
                conflicts: 0,
                decisions: 0,
                propagations: 0,
                explanations: 0,
                explain_hits: 0,
                root_probes: 0,
                imported: 0,
                restarts: 0,
                shrunk: 0,
                vivified: 0,
                vivified_lits: 0,
            },
        };
        // Initial phase: the denser lines lean towards filled.
        for r in 0..h {
            let dens = p.clue(r).iter().sum::<u32>() as f64 / w as f64;
            for c in 0..w {
                let dc = p.clue(h + c).iter().sum::<u32>() as f64 / h as f64;
                s.phase[r * w + c] = if dens + dc > 1.0 { 0 } else { 1 };
            }
        }
        for v in 0..nv {
            s.heap_insert(v);
        }
        s.original = s.phase.clone();
        s
    }

    /// Warm-up (kissat): set every phase by one pass of decisions with
    /// propagation from level 0, so the phases agree with propagation. A
    /// decision that fails is tried the other way; if that fails too, the
    /// cell keeps its old phase.
    fn warmup(&mut self) {
        debug_assert_eq!(self.decision_level(), 0);
        for v in 0..self.nv {
            if self.val[v] != UNDEF {
                continue;
            }
            for flip in [0u8, 1] {
                let lvl = self.decision_level();
                self.trail_lim.push(self.trail.len());
                self.assign(lit(v, (self.phase[v] ^ flip) == 1), Reason::Decision);
                if self.propagate().is_none() {
                    break;
                }
                self.cancel_until(lvl);
            }
        }
        for &l in &self.trail {
            self.phase[var(l)] = (l & 1) as u8;
        }
        self.cancel_until(0);
        self.dirty_rows = 0;
        self.dirty_cols = 0;
    }

    /// At a conflict: remember the trail if it is the longest so far.
    fn update_targets(&mut self) {
        // Only the consistent part of the trail: the levels below the one
        // that just failed (Biere & Fleury). Copying the whole trail took in
        // the contradictory last level.
        let n = match self.trail_lim.last() {
            Some(&lim) if self.consistent_targets => lim,
            _ => self.trail.len(),
        };
        if n > self.target_size {
            self.target_size = n;
            for &l in &self.trail[..n] {
                self.target[var(l)] = (l & 1) as u8;
            }
        }
        if n > self.best_size {
            self.best_size = n;
            for &l in &self.trail[..n] {
                self.best[var(l)] = (l & 1) as u8;
            }
        }
    }

    /// Reset the saved phases: best, original, best, inverted, best, flipped.
    fn rephase(&mut self, k: u64) {
        match k % 6 {
            5 => {
                for v in 0..self.nv {
                    self.phase[v] ^= 1;
                }
            }
            0 | 2 | 4 => {
                for v in 0..self.nv {
                    if self.best[v] != UNDEF {
                        self.phase[v] = self.best[v];
                    }
                }
            }
            1 => self.phase.copy_from_slice(&self.original),
            _ => {
                for v in 0..self.nv {
                    self.phase[v] = self.original[v] ^ 1;
                }
            }
        }
        self.target_size = 0;
        self.target.iter_mut().for_each(|x| *x = UNDEF);
    }

    #[inline(always)]
    fn decision_level(&self) -> u32 {
        self.trail_lim.len() as u32
    }

    /// Value of a literal: 1 true, 0 false, UNDEF.
    #[inline(always)]
    fn lit_val(&self, l: Lit) -> u8 {
        // SAFETY: literals are always below 2 * nv.
        unsafe { *self.lv.get_unchecked(l as usize) }
    }

    fn assign(&mut self, l: Lit, reason: Reason) {
        let v = var(l);
        debug_assert_eq!(self.val[v], UNDEF);
        let empty = l & 1 == 1;
        self.val[v] = empty as u8;
        self.lv[l as usize] = 1;
        self.lv[(l ^ 1) as usize] = 0;
        self.level[v] = self.decision_level();
        self.pos[v] = self.trail.len() as u32;
        self.reason[v] = reason;
        self.trail.push(l);
        if v >= self.ncell {
            if self.bounds {
                let b = self.yblock[v];
                if b != u32::MAX {
                    let blk = self.blocks[b as usize];
                    let bit: Mask = 1 << (blk.lo + (v as u32 - blk.base));
                    // Only a tighter bound can tell the line anything new; the
                    // chain clauses fill in looser ones after every bound.
                    let tighter = if empty {
                        let t = self.yfalse[b as usize] & bit.wrapping_sub(1) == 0;
                        self.yfalse[b as usize] |= bit;
                        t
                    } else {
                        let t = self.ytrue[b as usize] & !(bit | bit.wrapping_sub(1)) == 0;
                        self.ytrue[b as usize] |= bit;
                        t
                    };
                    let line = self.block_line[b as usize] as usize;
                    if tighter && !matches!(reason, Reason::Line(l) if l as usize == line) {
                        if line < self.h {
                            self.dirty_rows |= 1 << line
                        } else {
                            self.dirty_cols |= 1 << (line - self.h)
                        }
                    }
                }
            }
            return;
        }
        let (r, c) = (v / self.w, v % self.w);
        if empty {
            self.e[r] |= 1 << c;
            self.e[self.h + c] |= 1 << r;
        } else {
            self.f[r] |= 1 << c;
            self.f[self.h + c] |= 1 << r;
        }
        // The lines through the cell may now force more.
        match reason {
            Reason::Line(line) if (line as usize) < self.h => self.dirty_cols |= 1 << c,
            Reason::Line(_) => self.dirty_rows |= 1 << r,
            _ => {
                self.dirty_rows |= 1 << r;
                self.dirty_cols |= 1 << c;
            }
        }
    }

    fn cancel_until(&mut self, lvl: u32) {
        if self.decision_level() <= lvl {
            return;
        }
        let lim = self.trail_lim[lvl as usize];
        for i in (lim..self.trail.len()).rev() {
            let l = self.trail[i];
            let v = var(l);
            if v < self.ncell {
                let (r, c) = (v / self.w, v % self.w);
                self.f[r] &= !(1 << c);
                self.e[r] &= !(1 << c);
                self.f[self.h + c] &= !(1 << r);
                self.e[self.h + c] &= !(1 << r);
            } else if self.bounds {
                let b = self.yblock[v];
                if b != u32::MAX {
                    let blk = self.blocks[b as usize];
                    let bit: Mask = 1 << (blk.lo + (v as u32 - blk.base));
                    self.ytrue[b as usize] &= !bit;
                    self.yfalse[b as usize] &= !bit;
                }
            }
            self.phase[v] = self.val[v];
            self.val[v] = UNDEF;
            self.lv[2 * v] = UNDEF;
            self.lv[2 * v + 1] = UNDEF;
            self.heap_insert(v);
        }
        // Explanations of the unassigned variables go; only the few with
        // one are visited (clearing every variable's slot was 6 %).
        let mut i = 0;
        while i < self.expl_vars.len() {
            let v = self.expl_vars[i] as usize;
            if self.val[v] == UNDEF {
                self.expl[v] = None;
                self.expl_vars.swap_remove(i);
            } else {
                i += 1;
            }
        }
        self.trail.truncate(lim);
        self.trail_lim.truncate(lvl as usize);
        self.qhead = lim;
        // Every line was at a fixpoint at this level; learned clauses that
        // assert after the jump mark their own lines dirty.
        self.dirty_rows = 0;
        self.dirty_cols = 0;
    }

    // ── Clauses ─────────────────────────────────────────────────────────

    fn add_clause(&mut self, lits: Vec<Lit>, learnt: bool, lbd: u32) -> u32 {
        let cref = self.arena.len() as u32;
        if lits.len() >= 2 {
            let tag = if lits.len() == 2 { BIN } else { 0 };
            self.watches[(lits[0] ^ 1) as usize].push(Watch { cref: cref | tag, blocker: lits[1] });
            self.watches[(lits[1] ^ 1) as usize].push(Watch { cref: cref | tag, blocker: lits[0] });
        }
        self.arena.push(lits.len() as u32);
        self.arena.push(lbd.min(LBD_MASK) | if learnt { LEARNT } else { 0 });
        self.arena.extend_from_slice(&lits);
        if learnt {
            self.learnts.push(cref);
        }
        cref
    }

    #[inline(always)]
    fn c_lits(&self, c: u32) -> &[Lit] {
        let c = c as usize;
        let n = self.arena[c] as usize;
        &self.arena[c + 2..c + 2 + n]
    }

    /// Unit propagation over the clauses watching literal `l` becoming false
    /// (`l` itself just became true, so watches are keyed by the negation).
    fn propagate_clauses(&mut self) -> Option<Conflict> {
        while self.qhead < self.trail.len() {
            let l = self.trail[self.qhead];
            self.qhead += 1;
            if self.ladder_on {
                if let Some(c) = self.ladder_step(l) {
                    return Some(c);
                }
            }
            let mut ws = std::mem::take(&mut self.watches[l as usize]);
            let (mut i, mut j) = (0, 0);
            let false_lit = l ^ 1;
            let mut conflict = None;
            while i < ws.len() {
                let w = ws[i];
                i += 1;
                let bv = self.lit_val(w.blocker);
                if bv == 1 {
                    ws[j] = w;
                    j += 1;
                    continue;
                }
                if w.cref & BIN != 0 {
                    ws[j] = w;
                    j += 1;
                    let cref = w.cref & !BIN;
                    if bv == 0 {
                        conflict = Some(Conflict::Clause(cref));
                        while i < ws.len() {
                            ws[j] = ws[i];
                            j += 1;
                            i += 1;
                        }
                    } else {
                        self.stats.propagations += 1;
                        // The implied literal first, as for every reason clause.
                        // (A reason that names the other literal and never
                        // touches the arena measured worse: 67/72 against
                        // 69/72 on the 72-puzzle set, with time per conflict
                        // level.)
                        let c = cref as usize;
                        if self.arena[c + 2] != w.blocker {
                            self.arena.swap(c + 2, c + 3);
                        }
                        self.assign(w.blocker, Reason::Clause(cref));
                    }
                    continue;
                }
                let c = w.cref as usize;
                if self.arena[c + 1] & DELETED != 0 {
                    continue;
                }
                if w.cref == self.ignore {
                    ws[j] = w;
                    j += 1;
                    continue;
                }
                if self.arena[c + 2] == false_lit {
                    self.arena.swap(c + 2, c + 3);
                }
                let first = self.arena[c + 2];
                if first != w.blocker && self.lit_val(first) == 1 {
                    ws[j] = Watch { cref: w.cref, blocker: first };
                    j += 1;
                    continue;
                }
                // Find a new watch.
                let n = self.arena[c] as usize;
                let mut found = false;
                for k in c + 4..c + 2 + n {
                    let lk = self.arena[k];
                    if self.lit_val(lk) != 0 {
                        self.arena.swap(c + 3, k);
                        self.watches[(lk ^ 1) as usize].push(Watch { cref: w.cref, blocker: first });
                        found = true;
                        break;
                    }
                }
                if found {
                    continue;
                }
                ws[j] = Watch { cref: w.cref, blocker: first };
                j += 1;
                match self.lit_val(first) {
                    0 => {
                        conflict = Some(Conflict::Clause(w.cref));
                        while i < ws.len() {
                            ws[j] = ws[i];
                            j += 1;
                            i += 1;
                        }
                    }
                    UNDEF => {
                        self.stats.propagations += 1;
                        self.assign(first, Reason::Clause(w.cref));
                    }
                    _ => {}
                }
            }
            ws.truncate(j);
            // Nothing else was pushed onto this list meanwhile: a new watch
            // goes to the list of a literal that is not false, and only
            // false literals key this list.
            debug_assert!(self.watches[l as usize].is_empty());
            self.watches[l as usize] = ws;
            if conflict.is_some() {
                return conflict;
            }
        }
        None
    }

    /// The ladder of block-start literals, applied directly instead of
    /// through its two-literal clauses: y(j,p) -> y(j,p-1), and y(j,p) ->
    /// y(j+1,p+gap), each with its converse. These clauses were 76-88 % of
    /// strategy 1's propagations, each paid with a watch-list scan.
    #[inline]
    fn ladder_step(&mut self, l: Lit) -> Option<Conflict> {
        let v = var(l);
        let b = *self.yblock.get(v)?;
        if b == u32::MAX {
            return None;
        }
        let blk = self.blocks[b as usize];
        let p = blk.lo + (v as u32 - blk.base);
        if l & 1 == 0 {
            // y(j,p) true: the block starts at p or later.
            if p > blk.lo {
                if let Some(c) = self.implied(lit(v - 1, false), lit(v, true)) {
                    return Some(c);
                }
            }
            if let Some((nb, gap)) = blk.next {
                let n = self.blocks[nb as usize];
                let q = p + gap;
                if q > n.lo && q <= n.hi {
                    return self.implied(lit((n.base + q - n.lo) as usize, false), lit(v, true));
                }
            }
        } else {
            // y(j,p) false: the block starts before p.
            if p <= blk.hi {
                if let Some(c) = self.implied(lit(v + 1, true), lit(v, false)) {
                    return Some(c);
                }
            }
            let pb = self.yprev[b as usize];
            if pb != u32::MAX && p > blk.lo && p <= blk.hi {
                let q = self.blocks[pb as usize];
                let gap = q.next.unwrap().1;
                return self.implied(lit((q.base + p - gap - q.lo) as usize, true), lit(v, false));
            }
        }
        None
    }

    /// Make `x` true because `because` (false) is the other literal of its
    /// two-literal clause; the conflict if `x` is false.
    #[inline(always)]
    fn implied(&mut self, x: Lit, because: Lit) -> Option<Conflict> {
        match self.lit_val(x) {
            UNDEF => {
                self.stats.propagations += 1;
                self.assign(x, Reason::Implied(because));
                None
            }
            1 => None,
            _ => Some(Conflict::Pair(because, x)),
        }
    }

    /// Clauses first, then the line solver on dirty lines, to a fixpoint.
    fn propagate(&mut self) -> Option<Conflict> {
        loop {
            if let Some(c) = self.propagate_clauses() {
                return Some(c);
            }
            if self.dirty_rows | self.dirty_cols == 0 || !self.lines {
                return None;
            }
            // One line at a time, so clause propagation stays first.
            let line = if self.dirty_rows != 0 {
                let r = self.dirty_rows.trailing_zeros() as usize;
                self.dirty_rows &= self.dirty_rows - 1;
                r
            } else {
                let c = self.dirty_cols.trailing_zeros() as usize;
                self.dirty_cols &= self.dirty_cols - 1;
                self.h + c
            };
            let n = if line < self.h { self.w } else { self.h };
            let (f0, e0) = (self.f[line], self.e[line]);
            if self.bounds && !self.p.clue(line).is_empty() {
                if let Some(c) = self.solve_line_bounds(line, n, f0, e0) {
                    return Some(c);
                }
                continue;
            }
            let Some((f, e)) = solver::solve_line(self.p, line, n, f0, e0) else {
                return Some(Conflict::Line(line as u32));
            };
            let (nf, ne) = (f & !f0, e & !e0);
            for (mut x, empty) in [(nf, false), (ne, true)] {
                while x != 0 {
                    let i = x.trailing_zeros() as usize;
                    x &= x - 1;
                    let v = if line < self.h { line * self.w + i } else { i * self.w + (line - self.h) };
                    self.stats.propagations += 1;
                    self.assign(lit(v, empty), Reason::Line(line as u32));
                }
            }
        }
    }

    /// Lowest allowed start and first excluded start of block `b`, from
    /// its start literals now (y(j,lo) is true and y(j,hi+1) false from the
    /// start, so both masks are never empty).
    #[inline(always)]
    fn block_range(&self, b: usize) -> (u32, u32) {
        let lb = (Mask::BITS - 1) - self.ytrue[b].leading_zeros();
        let ub1 = self.yfalse[b].trailing_zeros();
        (lb, ub1)
    }

    /// The line propagator in bounds mode: cells and block starts together.
    /// Forced cells, and per block the tightest new bound literal (the
    /// chain clauses set the ones in between).
    fn solve_line_bounds(&mut self, line: usize, n: usize, f0: Mask, e0: Mask) -> Option<Conflict> {
        let clue = self.p.clue(line);
        let k = clue.len();
        let first = self.line_first[line] as usize;
        let mut allowed = [0 as Mask; 64];
        let mut range = [(0u32, 0u32); 64];
        for j in 0..k {
            let (lb, ub1) = self.block_range(first + j);
            range[j] = (lb, ub1);
            allowed[j] = ones(ub1 as usize) & !ones(lb as usize);
        }
        let mut starts = [0 as Mask; 64];
        let Some((f, e)) = crate::line::solve_bounds(n, clue, f0, e0, &allowed[..k], &mut starts[..k]) else {
            return Some(Conflict::Line(line as u32));
        };
        let (nf, ne) = (f & !f0, e & !e0);
        for (mut x, empty) in [(nf, false), (ne, true)] {
            while x != 0 {
                let i = x.trailing_zeros() as usize;
                x &= x - 1;
                let v = if line < self.h { line * self.w + i } else { i * self.w + (line - self.h) };
                self.stats.propagations += 1;
                self.assign(lit(v, empty), Reason::Line(line as u32));
            }
        }
        for j in 0..k {
            let blk = self.blocks[first + j];
            let (lb, ub1) = range[j];
            let new_lb = starts[j].trailing_zeros();
            if new_lb > lb {
                let y = (blk.base + new_lb - blk.lo) as usize;
                if self.val[y] == UNDEF {
                    self.stats.propagations += 1;
                    self.assign(lit(y, false), Reason::Line(line as u32));
                }
            }
            let new_ub1 = Mask::BITS - starts[j].leading_zeros();
            if new_ub1 < ub1 {
                let y = (blk.base + new_ub1 - blk.lo) as usize;
                if self.val[y] == UNDEF {
                    self.stats.propagations += 1;
                    self.assign(lit(y, true), Reason::Line(line as u32));
                }
            }
        }
        None
    }

    // ── Explanations ────────────────────────────────────────────────────

    /// The cells of `line` as literals true now, with trail position below
    /// `before`, latest first.
    fn line_context(&self, line: usize, before: u32) -> Vec<Lit> {
        let n = if line < self.h { self.w } else { self.h };
        let mut out = Vec::new();
        for i in 0..n {
            let v = if line < self.h { line * self.w + i } else { i * self.w + (line - self.h) };
            if self.val[v] != UNDEF && self.pos[v] < before {
                out.push(lit(v, self.val[v] == 1));
            }
        }
        if self.bounds {
            // The tightest bound literals of each block assigned before.
            let first = self.line_first[line] as usize;
            for b in first..first + self.p.clue(line).len() {
                let blk = self.blocks[b];
                let y = |p: u32| (blk.base + p - blk.lo) as usize;
                if let Some(p) = (blk.lo + 1..=blk.hi).rev().find(|&p| self.val[y(p)] == 0 && self.pos[y(p)] < before) {
                    out.push(lit(y(p), false));
                }
                if let Some(p) = (blk.lo + 1..=blk.hi).find(|&p| self.val[y(p)] == 1 && self.pos[y(p)] < before) {
                    out.push(lit(y(p), true));
                }
            }
        }
        // Latest first; one u64 key per literal sorts faster than a closure.
        let mut keyed: Vec<u64> = out.iter().map(|&l| (self.pos[var(l)] as u64) << 32 | l as u64).collect();
        keyed.sort_unstable_by(|a, b| b.cmp(a));
        keyed.into_iter().map(|k| k as u32).collect()
    }

    /// Masks of `line` from a set of true literals.
    fn masks_of(&self, line: usize, lits: &[Lit], skip: usize) -> (Mask, Mask) {
        let (mut f, mut e) = (0 as Mask, 0 as Mask);
        for (k, &l) in lits.iter().enumerate() {
            if k == skip {
                continue;
            }
            let v = var(l);
            let i = if line < self.h { v % self.w } else { v / self.w };
            if l & 1 == 1 {
                e |= 1 << i
            } else {
                f |= 1 << i
            }
        }
        (f, e)
    }

    /// Shrink `ctx` to a subset under which the line solver still reaches
    /// `goal` (a forced literal, or None for "no placement"), by
    /// QuickXplain: about k·log(n/k) line solves for an explanation of k
    /// cells out of n, against n for removing cells one at a time. `ctx` is
    /// latest first; QuickXplain keeps the earliest cells it can, so learned
    /// clauses lean on early cells and jump back further.
    fn shrink(&mut self, line: usize, ctx: Vec<Lit>, goal: Option<Lit>) -> Vec<Lit> {
        self.stats.explanations += 1;
        let t0 = Instant::now();
        if self.bounds && !self.p.clue(line).is_empty() {
            let out = self.shrink_bounds(line, ctx, goal);
            self.stats.explain_ns += t0.elapsed().as_nanos() as u64;
            return out;
        }
        // The explanation depends only on the line, its known cells and the
        // goal, and after a backjump the search often rebuilds exactly the
        // same line state, so a direct-mapped cache answers repeats.
        let at = |v: usize| if line < self.h { v % self.w } else { v / self.w };
        let (cf, ce) = self.masks_of(line, &ctx, usize::MAX);
        let gk: u32 = goal.map_or(u32::MAX, |g| (at(var(g)) as u32) << 1 | (g & 1));
        let fold = |x: Mask| (x as u64) ^ ((x >> 64) as u64).rotate_left(23);
        let hsh = (fold(cf).wrapping_mul(0x9E37_79B9_7F4A_7C15)
            ^ fold(ce).wrapping_mul(0xC2B2_AE3D_27D4_EB4F)
            ^ ((line as u64) << 32 | gk as u64).wrapping_mul(0x1656_67B1_9E37_79F9))
            >> (64 - EXPL_CACHE_BITS);
        let slot = &self.expl_cache[hsh as usize];
        let out = if slot.line == line as u32 && slot.goal == gk && slot.f == cf && slot.e == ce {
            self.stats.explain_hits += 1;
            let (rf, re) = (slot.rf, slot.re);
            ctx.into_iter()
                .filter(|&l| {
                    let b: Mask = 1 << at(var(l));
                    if l & 1 == 1 {
                        re & b != 0
                    } else {
                        rf & b != 0
                    }
                })
                .collect()
        } else {
            let out = self.shrink_inner(line, ctx, goal);
            let (rf, re) = self.masks_of(line, &out, usize::MAX);
            self.expl_cache[hsh as usize] = ExplEntry { line: line as u32, goal: gk, f: cf, e: ce, rf, re };
            out
        };
        self.stats.explain_ns += t0.elapsed().as_nanos() as u64;
        out
    }

    /// QuickXplain over cells and block-start bounds (bounds mode). An item
    /// is a literal; the state is the line's cells and, per block, the
    /// lowest allowed start and the first excluded one.
    fn shrink_bounds(&mut self, line: usize, ctx: Vec<Lit>, goal: Option<Lit>) -> Vec<Lit> {
        #[derive(Clone, Copy)]
        struct St {
            f: Mask,
            e: Mask,
            lb: [u8; 64],
            ub1: [u8; 64],
        }
        let n = if line < self.h { self.w } else { self.h };
        let clue = self.p.clue(line);
        let k = clue.len();
        let first = self.line_first[line] as usize;
        let (h, w) = (self.h, self.w);
        let ncell = self.ncell;
        let blocks = &self.blocks;
        let yblock = &self.yblock;
        // What a literal adds to the state.
        let add = |st: &mut St, l: Lit| {
            let v = var(l);
            if v < ncell {
                let i = if line < h { v % w } else { v / w };
                if l & 1 == 1 {
                    st.e |= 1 << i
                } else {
                    st.f |= 1 << i
                }
            } else {
                let b = yblock[v] as usize;
                let blk = blocks[b];
                let p = (blk.lo + (v as u32 - blk.base)) as u8;
                let j = b - first;
                if l & 1 == 1 {
                    st.ub1[j] = st.ub1[j].min(p)
                } else {
                    st.lb[j] = st.lb[j].max(p)
                }
            }
        };
        let mut base = St { f: 0, e: 0, lb: [0; 64], ub1: [0; 64] };
        for j in 0..k {
            base.lb[j] = blocks[first + j].lo as u8;
            base.ub1[j] = (blocks[first + j].hi + 1) as u8;
        }
        // The opposite of the goal, added to every check.
        let mut opp = base;
        let mut goal_none = true;
        if let Some(g) = goal {
            goal_none = false;
            add(&mut opp, g ^ 1);
        }
        let holds = |st: &St| -> bool {
            let mut allowed = [0 as Mask; 64];
            for j in 0..k {
                let lb = st.lb[j].max(opp.lb[j]) as usize;
                let ub1 = st.ub1[j].min(opp.ub1[j]) as usize;
                allowed[j] = if ub1 > lb { ones(ub1) & !ones(lb) } else { 0 };
            }
            let (f, e) = if goal_none { (st.f, st.e) } else { (st.f | opp.f, st.e | opp.e) };
            !crate::line::feasible_bounds(n, clue, f, e, &allowed[..k])
        };
        fn qx(
            holds: &dyn Fn(&St) -> bool,
            add: &dyn Fn(&mut St, Lit),
            bg: St,
            changed: bool,
            c: &[Lit],
            out: &mut Vec<Lit>,
        ) {
            if changed && holds(&bg) {
                return;
            }
            if c.len() == 1 {
                out.push(c[0]);
                return;
            }
            let (c1, c2) = c.split_at(c.len() / 2);
            let mut b1 = bg;
            for &l in c1 {
                add(&mut b1, l);
            }
            let start = out.len();
            qx(holds, add, b1, !c1.is_empty(), c2, out);
            let mut b2 = bg;
            for &l in &out[start..] {
                add(&mut b2, l);
            }
            let d2 = out.len() > start;
            qx(holds, add, b2, d2, c1, out);
        }
        // Earliest first, as for cells.
        let items: Vec<Lit> = ctx.into_iter().rev().collect();
        let mut out = Vec::new();
        if !items.is_empty() {
            qx(&holds, &add, base, false, &items, &mut out);
        }
        out
    }

    fn shrink_inner(&mut self, line: usize, ctx: Vec<Lit>, goal: Option<Lit>) -> Vec<Lit> {
        let n = if line < self.h { self.w } else { self.h };
        let at = |v: usize| if line < self.h { v % self.w } else { v / self.w };
        // Earliest first, as (bit, empty).
        let items: Vec<(Mask, bool)> = ctx.iter().rev().map(|&l| ((1 as Mask) << at(var(l)), l & 1 == 1)).collect();
        let clue = self.p.clue(line);
        let goal_bit = goal.map(|g| ((1 as Mask) << at(var(g)), g & 1 == 1));
        // The set still explains the goal when the line cannot take the
        // opposite value (or, for a conflict, has no placement at all): a
        // feasibility check, half the cost of a full line solve.
        let holds = |f: Mask, e: Mask| -> bool {
            match goal_bit {
                None => !crate::line::feasible(n, clue, f, e),
                Some((b, true)) => !crate::line::feasible(n, clue, f | b, e),
                Some((b, false)) => !crate::line::feasible(n, clue, f, e | b),
            }
        };
        fn masks(items: &[(Mask, bool)]) -> (Mask, Mask) {
            let (mut f, mut e) = (0, 0);
            for &(b, empty) in items {
                if empty {
                    e |= b
                } else {
                    f |= b
                }
            }
            (f, e)
        }
        // qx(background, changed, candidates) -> the candidates needed.
        fn qx(
            holds: &dyn Fn(Mask, Mask) -> bool,
            bf: Mask,
            be: Mask,
            changed: bool,
            c: &[(Mask, bool)],
            out: &mut Vec<(Mask, bool)>,
        ) {
            if changed && holds(bf, be) {
                return;
            }
            if c.len() == 1 {
                out.push(c[0]);
                return;
            }
            let (c1, c2) = c.split_at(c.len() / 2);
            let (f1, e1) = masks(c1);
            let start = out.len();
            qx(holds, bf | f1, be | e1, !c1.is_empty(), c2, out);
            let (f2, e2) = masks(&out[start..]);
            let d2_nonempty = out.len() > start;
            qx(holds, bf | f2, be | e2, d2_nonempty, c1, out);
        }
        // Most cells that matter lie near the forced cell. Find the smallest
        // window around it whose known cells still explain it (log2 n
        // feasibility checks), then run QuickXplain inside the window only.
        let mut cand = items;
        if let (Some((b, _)), true) = (goal_bit, window_explanations()) {
            let gi = b.trailing_zeros() as i64;
            let (af, ae) = masks(&cand);
            let window = |r: i64| -> Mask {
                let lo = (gi - r).max(0) as u32;
                let hi = (gi + r).min(n as i64 - 1) as u32;
                ones(hi as usize + 1) & !ones(lo as usize)
            };
            let (mut lo, mut hi) = (0i64, n as i64);
            while lo < hi {
                let mid = (lo + hi) / 2;
                let wm = window(mid);
                if holds(af & wm, ae & wm) {
                    hi = mid
                } else {
                    lo = mid + 1
                }
            }
            let wm = window(lo);
            cand.retain(|&(bit, _)| bit & wm != 0);
        }
        let mut out = Vec::new();
        if !cand.is_empty() {
            qx(&holds, 0, 0, false, &cand, &mut out);
        }
        // Back to literals.
        let lit_at = |b: Mask, empty: bool| -> Lit {
            let i = b.trailing_zeros() as usize;
            let v = if line < self.h { line * self.w + i } else { i * self.w + (line - self.h) };
            lit(v, empty)
        };
        out.into_iter().map(|(b, e)| lit_at(b, e)).collect()
    }

    /// As `reason_lits`, into a reused buffer: conflict analysis calls this
    /// for every literal it resolves, and allocating each time was 15 % of
    /// the run time.
    fn reason_into(&mut self, l: Lit, out: &mut Vec<Lit>) {
        out.clear();
        let v = var(l);
        match self.reason[v] {
            Reason::Decision => {}
            Reason::Implied(x) => out.push(x),
            Reason::Clause(cref) => {
                let c = cref as usize;
                let n = self.arena[c] as usize;
                for k in c + 2..c + 2 + n {
                    let x = self.arena[k];
                    if x != l {
                        out.push(x);
                    }
                }
            }
            Reason::Line(_) => {
                if self.expl[v].is_none() {
                    let e = self.reason_lits(l);
                    out.extend_from_slice(&e);
                } else {
                    out.extend_from_slice(self.expl[v].as_ref().unwrap());
                }
            }
        }
    }

    /// The reason for literal `l` as a clause body: literals that are false
    /// now (the negations of the cells that forced `l`).
    fn reason_lits(&mut self, l: Lit) -> Vec<Lit> {
        let v = var(l);
        match self.reason[v] {
            Reason::Decision => Vec::new(),
            Reason::Implied(x) => vec![x],
            Reason::Clause(cref) => self.c_lits(cref).iter().copied().filter(|&x| x != l).collect(),
            Reason::Line(line) => {
                if let Some(e) = &self.expl[v] {
                    return e.clone();
                }
                let ctx = self.line_context(line as usize, self.pos[v]);
                let ex: Vec<Lit> = self.shrink(line as usize, ctx, Some(l)).into_iter().map(|x| x ^ 1).collect();
                self.expl[v] = Some(ex.clone());
                self.expl_vars.push(v as u32);
                ex
            }
        }
    }

    fn conflict_lits(&mut self, c: &Conflict) -> Vec<Lit> {
        match *c {
            Conflict::Clause(cref) => self.c_lits(cref).to_vec(),
            Conflict::Pair(a, b) => vec![a, b],
            Conflict::Line(line) => {
                let ctx = self.line_context(line as usize, u32::MAX);
                self.shrink(line as usize, ctx, None).into_iter().map(|x| x ^ 1).collect()
            }
        }
    }

    // ── Conflict analysis ───────────────────────────────────────────────

    /// First-UIP learning. Returns the clause (asserting literal first) and
    /// the level to jump back to.
    fn analyze(&mut self, conflict: Conflict) -> (Vec<Lit>, u32) {
        let cur = self.decision_level();
        let mut learnt: Vec<Lit> = vec![0];
        let mut counter = 0;
        let mut body = std::mem::take(&mut self.tmp);
        body.clear();
        body.extend(self.conflict_lits(&conflict));
        if let Conflict::Clause(c) = conflict {
            self.touch_clause(c);
        }
        let mut idx = self.trail.len();
        let mut p: Option<Lit>;
        let mut touched: Vec<usize> = Vec::new();
        loop {
            for &q in &body {
                let v = var(q);
                if self.seen[v] == 0 && self.level[v] > 0 {
                    self.seen[v] = 1;
                    touched.push(v);
                    self.bump(v);
                    if self.level[v] >= cur {
                        counter += 1;
                    } else {
                        learnt.push(q);
                    }
                }
            }
            // The next literal of the current level on the trail.
            loop {
                idx -= 1;
                if self.seen[var(self.trail[idx])] != 0 {
                    break;
                }
            }
            let pl = self.trail[idx];
            p = Some(pl);
            self.seen[var(pl)] = 0;
            counter -= 1;
            if counter == 0 {
                break;
            }
            if let Reason::Clause(c) = self.reason[var(pl)] {
                self.touch_clause(c);
            }
            self.reason_into(pl, &mut body);
        }
        learnt[0] = p.unwrap() ^ 1;
        self.tmp = body;
        if self.shrink {
            self.shrink_clause(&mut learnt, &mut touched);
        }

        // Recursive minimisation (MiniSat): drop a literal when every
        // literal in its chain of reasons is already in the clause or at
        // level 0. Reasons are clauses, or line explanations already built
        // (building new ones here cost more than it removed).
        let mut keep = vec![learnt[0]];
        // The levels in the clause, as a 32-bit set: a literal at a level
        // outside it cannot follow from the clause.
        let abs = learnt[1..].iter().fold(0u32, |a, &q| a | 1 << (self.level[var(q)] & 31));
        for &q in &learnt[1..] {
            let removable = if self.minimise >= 3 {
                self.removable(q, &mut touched, abs)
            } else {
                self.redundant(q, &mut touched, abs)
            };
            if !removable {
                keep.push(q);
            }
        }
        // Reason-side bumping (kissat): the variables that forced the
        // clause's literals matter too. Only reasons at hand: clauses and
        // explanations already built.
        if keep.len() <= reason_bump() {
            let mut reasons = std::mem::take(&mut self.tmp2);
            for i in 0..keep.len() {
                let v = var(keep[i]);
                let ready = match self.reason[v] {
                    Reason::Clause(_) | Reason::Implied(_) => true,
                    Reason::Line(_) => self.expl[v].is_some(),
                    Reason::Decision => false,
                };
                if !ready {
                    continue;
                }
                self.reason_into(keep[i] ^ 1, &mut reasons);
                for &r in reasons.iter() {
                    let u = var(r);
                    if self.seen[u] == 0 && self.level[u] > 0 {
                        self.seen[u] = 2;
                        touched.push(u);
                        self.bump(u);
                    }
                }
            }
            self.tmp2 = reasons;
        }
        for v in touched {
            self.seen[v] = 0;
        }
        let mut learnt = keep;
        // Put the highest-level literal second, for the watches.
        let mut bt = 0;
        if learnt.len() > 1 {
            let mut mi = 1;
            for i in 2..learnt.len() {
                if self.level[var(learnt[i])] > self.level[var(learnt[mi])] {
                    mi = i;
                }
            }
            learnt.swap(1, mi);
            bt = self.level[var(learnt[1])];
        }
        self.decay();
        (learnt, bt)
    }

    /// Vivification (kissat), at level 0: for up to `n` learned clauses not
    /// vivified yet, lowest LBD first, assign the negation of the literals
    /// one by one with full propagation, leaving the clause itself out. A
    /// conflict, a literal of the clause turning true, or literals turning
    /// false, each give a shorter clause the puzzle implies. Saved phases
    /// are restored, so the search continues where it was.
    fn vivify(&mut self, n: usize) {
        debug_assert_eq!(self.decision_level(), 0);
        let mut cand: Vec<u32> = self
            .learnts
            .iter()
            .copied()
            .filter(|&c| {
                let f = self.arena[c as usize + 1];
                f & (VIVIFIED | DELETED) == 0 && self.arena[c as usize] > 2
            })
            .collect();
        cand.sort_by_key(|&c| (self.arena[c as usize + 1] & LBD_MASK, self.arena[c as usize]));
        cand.truncate(n);
        if cand.is_empty() {
            return;
        }
        let phase = self.phase.clone();
        let mut units = Vec::new();
        for c in cand {
            self.arena[c as usize + 1] |= VIVIFIED;
            let lits = self.c_lits(c).to_vec();
            // Satisfied at level 0 (this covers a clause that is a level-0
            // reason): leave it.
            if lits.iter().any(|&l| self.lit_val(l) == 1) {
                continue;
            }
            self.ignore = c;
            let mut prefix: Vec<Lit> = Vec::with_capacity(lits.len());
            let mut shorter = false;
            for &l in &lits {
                match self.lit_val(l) {
                    1 => {
                        prefix.push(l);
                        shorter = true;
                        break;
                    }
                    0 => {
                        shorter = true;
                        continue;
                    }
                    _ => {}
                }
                prefix.push(l);
                self.trail_lim.push(self.trail.len());
                self.assign(l ^ 1, Reason::Decision);
                if self.propagate().is_some() {
                    shorter = shorter || prefix.len() < lits.len();
                    break;
                }
            }
            self.cancel_until(0);
            self.ignore = u32::MAX;
            if !shorter || prefix.len() >= lits.len() {
                continue;
            }
            // Literals false at level 0 add nothing.
            prefix.retain(|&l| self.lit_val(l) != 0);
            self.stats.vivified += 1;
            self.stats.vivified_lits += (lits.len() - prefix.len()) as u64;
            let old = self.arena[c as usize + 1];
            self.arena[c as usize + 1] |= DELETED;
            self.garbage += lits.len() + 2;
            match prefix.len() {
                0 => units.push(None),
                1 => units.push(Some(prefix[0])),
                k => {
                    let lbd = (old & LBD_MASK).min(k as u32 - 1);
                    let nc = self.add_clause(prefix, true, lbd);
                    self.arena[nc as usize + 1] |= VIVIFIED | (old & USED_MASK);
                }
            }
        }
        self.phase = phase;
        let arena = &self.arena;
        self.learnts.retain(|&c| arena[c as usize + 1] & DELETED == 0);
        // Units hold at level 0; the main loop propagates them (and finds a
        // level-0 conflict if there is no further solution).
        for u in units {
            match u {
                Some(l) if self.lit_val(l) == UNDEF => self.assign(l, Reason::Decision),
                Some(l) if self.lit_val(l) == 1 => {}
                _ => {
                    // The empty clause, or a unit already false: no solution
                    // beyond those found. Leave a level-0 conflict to find.
                    self.unsat = true;
                }
            }
        }
    }

    /// Shrinking (Fleury & Biere, all-UIP minimisation): where the clause
    /// has several literals of one lower level, replace them by the single
    /// literal of that level that implies all of them, if there is one
    /// whose derivation needs only that level and literals already in the
    /// clause.
    fn shrink_clause(&mut self, learnt: &mut Vec<Lit>, touched: &mut Vec<usize>) {
        let mut lits: Vec<Lit> = learnt[1..].to_vec();
        lits.sort_unstable_by_key(|&l| std::cmp::Reverse(self.level[var(l)]));
        let mut out = vec![learnt[0]];
        let mut i = 0;
        while i < lits.len() {
            let lvl = self.level[var(lits[i])];
            let mut j = i;
            while j < lits.len() && self.level[var(lits[j])] == lvl {
                j += 1;
            }
            if j - i == 1 {
                out.push(lits[i]);
            } else if let Some(u) = self.block_uip(lvl, &lits[i..j]) {
                // The replaced literals stay marked: the clause implies them.
                if self.seen[var(u)] == 0 {
                    self.seen[var(u)] = 1;
                    touched.push(var(u));
                }
                out.push(u);
                self.stats.shrunk += (j - i - 1) as u64;
            } else {
                out.extend_from_slice(&lits[i..j]);
            }
            i = j;
        }
        *learnt = out;
    }

    /// The literal (false, as in the clause) that implies every literal of
    /// `block` at level `lvl`, or None.
    fn block_uip(&mut self, lvl: u32, block: &[Lit]) -> Option<Lit> {
        self.shrink_clock += 1;
        let clk = self.shrink_clock;
        let mut open = 0usize;
        let mut idx = 0usize;
        for &q in block {
            let v = var(q);
            self.shrink_stamp[v] = clk;
            open += 1;
            idx = idx.max(self.pos[v] as usize + 1);
        }
        let mut reasons = std::mem::take(&mut self.tmp2);
        let result = loop {
            loop {
                idx -= 1;
                if self.shrink_stamp[var(self.trail[idx])] == clk {
                    break;
                }
            }
            let t = self.trail[idx];
            if open == 1 {
                break Some(t ^ 1);
            }
            open -= 1;
            if self.reason[var(t)] == Reason::Decision {
                break None;
            }
            self.reason_into(t, &mut reasons);
            let mut ok = true;
            for &r in reasons.iter() {
                let u = var(r);
                let lu = self.level[u];
                if lu == 0 {
                    continue;
                }
                if lu == lvl {
                    if self.shrink_stamp[u] != clk {
                        self.shrink_stamp[u] = clk;
                        open += 1;
                    }
                } else if lu > lvl || self.seen[u] != 1 {
                    ok = false;
                    break;
                }
            }
            if !ok {
                break None;
            }
        };
        self.tmp2 = reasons;
        result
    }

    /// Literal `i` of the reason of assigned variable `v` (a false
    /// literal), or None past the end. The reason must be a clause or a
    /// built explanation. A reason clause holds its implied literal first.
    #[inline(always)]
    fn reason_lit(&self, v: usize, i: usize) -> Option<Lit> {
        match self.reason[v] {
            Reason::Clause(c) => {
                let c = c as usize;
                let n = self.arena[c] as usize;
                (i + 1 < n).then(|| self.arena[c + 3 + i])
            }
            Reason::Implied(x) => (i == 0).then_some(x),
            Reason::Line(_) => self.expl[v].as_ref().and_then(|e| e.get(i).copied()),
            Reason::Decision => None,
        }
    }

    /// Build the explanation of a line-forced variable if it is missing.
    fn ensure_reason(&mut self, v: usize) {
        if matches!(self.reason[v], Reason::Line(_)) && self.expl[v].is_none() {
            self.reason_lits(lit(v, self.val[v] == 1));
        }
    }

    /// Minimisation as a depth-first search that records its result for
    /// every variable it visits (CaDiCaL): 1 implied by the clause, 3 not.
    /// The first version unmarked everything after a failure, so later
    /// literals explored the same trees again; on long chains of
    /// block-position clauses that made analysis cost up to 150 us per
    /// conflict.
    fn removable(&mut self, q: Lit, touched: &mut Vec<usize>, abs: u32) -> bool {
        const DEPTH: usize = 1000;
        let root = var(q);
        if self.reason[root] == Reason::Decision {
            return false;
        }
        self.ensure_reason(root);
        let mut stack = std::mem::take(&mut self.dfs);
        stack.clear();
        stack.push((root, 0usize));
        let ok = loop {
            let (v, i) = *stack.last().unwrap();
            match self.reason_lit(v, i) {
                Some(r) => {
                    stack.last_mut().unwrap().1 += 1;
                    let u = var(r);
                    if self.level[u] == 0 || self.seen[u] == 1 {
                        continue;
                    }
                    let fails = self.seen[u] == 3
                        || self.reason[u] == Reason::Decision
                        || abs >> (self.level[u] & 31) & 1 == 0
                        || stack.len() >= DEPTH;
                    if fails {
                        if self.seen[u] == 0 {
                            self.seen[u] = 3;
                            touched.push(u);
                        }
                        // Everything on the path depends on u. The root is
                        // in the clause and stays marked 1.
                        for &(w, _) in &stack[1..] {
                            self.seen[w] = 3;
                            touched.push(w);
                        }
                        break false;
                    }
                    self.ensure_reason(u);
                    stack.push((u, 0));
                }
                None => {
                    stack.pop();
                    if stack.is_empty() {
                        break true;
                    }
                    self.seen[v] = 1;
                    touched.push(v);
                }
            }
        };
        self.dfs = stack;
        ok
    }

    /// Whether false literal `q` of a learned clause follows from the
    /// others (all marked `seen`) through its reasons. Marks what it proves;
    /// undoes its marks when it fails.
    fn redundant(&mut self, q: Lit, touched: &mut Vec<usize>, abs: u32) -> bool {
        let usable = |s: &Self, v: usize| match s.reason[v] {
            Reason::Decision => false,
            Reason::Line(_) => s.expl[v].is_some() || minimise_all(),
            Reason::Clause(_) | Reason::Implied(_) => true,
        };
        if !usable(self, var(q)) {
            return false;
        }
        let top = touched.len();
        let mut stack = std::mem::take(&mut self.stack);
        stack.clear();
        stack.push(q);
        let mut reasons = std::mem::take(&mut self.tmp2);
        while let Some(x) = stack.pop() {
            self.reason_into(x ^ 1, &mut reasons);
            for &r in reasons.iter() {
                let v = var(r);
                if self.seen[v] == 1 || self.level[v] == 0 {
                    continue;
                }
                // Fails: a decision, an unbuilt explanation, a level not in
                // the clause, or a literal that failed before (poison).
                let fail = !usable(self, v)
                    || (self.minimise >= 1 && self.seen[v] == 3)
                    || (self.minimise >= 2 && abs >> (self.level[v] & 31) & 1 == 0);
                if fail {
                    for &u in &touched[top..] {
                        self.seen[u] = 0;
                    }
                    touched.truncate(top);
                    if self.minimise >= 1 && self.seen[v] == 0 {
                        // v itself does not follow from the clause.
                        self.seen[v] = 3;
                        touched.push(v);
                    }
                    self.tmp2 = reasons;
                    self.stack = stack;
                    return false;
                }
                self.seen[v] = 1;
                touched.push(v);
                stack.push(r);
            }
        }
        self.tmp2 = reasons;
        self.stack = stack;
        true
    }

    fn lbd(&mut self, lits: &[Lit]) -> u32 {
        self.lbd_clock += 1;
        let mut n = 0;
        for &l in lits {
            let lvl = self.level[var(l)] as usize;
            if self.lbd_stamp[lvl] != self.lbd_clock {
                self.lbd_stamp[lvl] = self.lbd_clock;
                n += 1;
            }
        }
        n
    }

    /// A learned clause took part in a conflict: mark it used, and lower
    /// its LBD if it now spans fewer levels (clause tiers, as in kissat).
    fn touch_clause(&mut self, c: u32) {
        let c = c as usize;
        let f = self.arena[c + 1];
        if f & LEARNT == 0 || !tiers() {
            return;
        }
        let mut lbd = f & LBD_MASK;
        if lbd > 2 {
            let n = self.arena[c] as usize;
            let lits = self.arena[c + 2..c + 2 + n].to_vec();
            lbd = lbd.min(self.lbd(&lits));
        }
        let used = if lbd <= 6 { 2 } else { 1 };
        self.arena[c + 1] = (f & !(LBD_MASK | USED_MASK)) | lbd | (used * USED_ONE);
    }

    // ── VSIDS heap ──────────────────────────────────────────────────────

    fn bump(&mut self, v: usize) {
        self.activity[v] += self.var_inc;
        if self.activity[v] > 1e100 {
            for a in &mut self.activity {
                *a *= 1e-100;
            }
            self.var_inc *= 1e-100;
        }
        if self.heap_pos[v] >= 0 {
            self.heap_up(self.heap_pos[v] as usize);
        }
    }

    fn decay(&mut self) {
        self.var_inc /= self.decay;
    }

    fn heap_insert(&mut self, v: usize) {
        if self.heap_pos[v] >= 0 {
            return;
        }
        self.heap_pos[v] = self.heap.len() as i32;
        self.heap.push(v as u32);
        self.heap_up(self.heap.len() - 1);
    }

    fn heap_up(&mut self, mut i: usize) {
        let x = self.heap[i];
        while i > 0 {
            let parent = (i - 1) / 2;
            if self.activity[self.heap[parent] as usize] >= self.activity[x as usize] {
                break;
            }
            self.heap[i] = self.heap[parent];
            self.heap_pos[self.heap[i] as usize] = i as i32;
            i = parent;
        }
        self.heap[i] = x;
        self.heap_pos[x as usize] = i as i32;
    }

    fn heap_pop(&mut self) -> Option<usize> {
        if self.heap.is_empty() {
            return None;
        }
        let top = self.heap[0] as usize;
        let last = self.heap.pop().unwrap();
        self.heap_pos[top] = -1;
        if !self.heap.is_empty() {
            self.heap[0] = last;
            self.heap_pos[last as usize] = 0;
            let mut i = 0;
            let n = self.heap.len();
            loop {
                let (l, r) = (2 * i + 1, 2 * i + 2);
                let mut m = i;
                if l < n && self.activity[self.heap[l] as usize] > self.activity[self.heap[m] as usize] {
                    m = l;
                }
                if r < n && self.activity[self.heap[r] as usize] > self.activity[self.heap[m] as usize] {
                    m = r;
                }
                if m == i {
                    break;
                }
                self.heap.swap(i, m);
                self.heap_pos[self.heap[i] as usize] = i as i32;
                self.heap_pos[self.heap[m] as usize] = m as i32;
                i = m;
            }
        }
        Some(top)
    }

    fn pick(&mut self) -> Option<Lit> {
        while let Some(v) = self.heap_pop() {
            if self.val[v] == UNDEF {
                let ph = if self.stable && self.target[v] != UNDEF { self.target[v] } else { self.phase[v] };
                return Some(lit(v, ph == 1));
            }
        }
        None
    }

    // ── Clause database ─────────────────────────────────────────────────

    fn reduce_db(&mut self) {
        let lbd = |s: &Self, c: u32| s.arena[c as usize + 1] & LBD_MASK;
        let mut cand: Vec<u32> = self.learnts.iter().copied().filter(|&c| lbd(self, c) > 2).collect();
        if tiers() {
            // A clause used since the last reduction stays for this round
            // (LBD up to 6: two rounds); the rest go by LBD, then size.
            let arena = &mut self.arena;
            cand.retain(|&c| {
                let f = arena[c as usize + 1];
                if f & USED_MASK != 0 {
                    arena[c as usize + 1] = f - USED_ONE;
                    false
                } else {
                    true
                }
            });
            cand.sort_by_key(|&c| std::cmp::Reverse((lbd(self, c), self.arena[c as usize])));
        } else {
            cand.sort_by_key(|&c| std::cmp::Reverse(lbd(self, c)));
        }
        let locked = |s: &Self, c: u32| {
            let l0 = s.arena[c as usize + 2];
            s.lit_val(l0) == 1 && s.reason[var(l0)] == Reason::Clause(c)
        };
        for &c in cand.iter().take(cand.len() / 2) {
            if !locked(self, c) {
                self.arena[c as usize + 1] |= DELETED;
                self.garbage += self.arena[c as usize] as usize + 2;
            }
        }
        let arena = &self.arena;
        self.learnts.retain(|&c| arena[c as usize + 1] & DELETED == 0);
        if self.garbage * 2 > self.arena.len() {
            self.collect_garbage();
        }
    }

    /// Compact the arena and move every reference to the new offsets.
    fn collect_garbage(&mut self) {
        let mut fresh: Vec<u32> = Vec::with_capacity(self.arena.len() - self.garbage);
        let mut moved: Vec<(u32, u32)> = Vec::new();
        let mut c = 0usize;
        while c < self.arena.len() {
            let n = self.arena[c] as usize;
            if self.arena[c + 1] & DELETED == 0 {
                moved.push((c as u32, fresh.len() as u32));
                fresh.extend_from_slice(&self.arena[c..c + 2 + n]);
            }
            c += 2 + n;
        }
        let map = |old: u32| moved.binary_search_by_key(&old, |&(o, _)| o).ok().map(|i| moved[i].1);
        for ws in &mut self.watches {
            ws.retain_mut(|w| match map(w.cref & !BIN) {
                Some(n) => {
                    w.cref = n | (w.cref & BIN);
                    true
                }
                None => false,
            });
        }
        for &l in &self.trail {
            let v = var(l);
            if let Reason::Clause(c) = self.reason[v] {
                self.reason[v] = Reason::Clause(map(c).expect("a reason clause is never deleted"));
            }
        }
        for c in &mut self.learnts {
            *c = map(*c).expect("live learned clause");
        }
        self.arena = fresh;
        self.garbage = 0;
    }

    fn to_grid(&self) -> Grid {
        let mut m = vec![0 as Mask; 2 * (self.h + self.w)];
        for line in 0..self.h + self.w {
            m[2 * line] = self.f[line];
            m[2 * line + 1] = self.e[line];
        }
        Grid { m }
    }
}

/// Switches for the kissat-style phase techniques, read once.
#[derive(Clone, Copy)]
struct Options {
    target: bool,
    modes: bool,
    rephase: bool,
    aux: bool,
    lines: bool,
    glucose: bool,
    warmup: bool,
    rootprobe: bool,
    share_clauses: bool,
}

fn options() -> Options {
    static O: std::sync::OnceLock<Options> = std::sync::OnceLock::new();
    *O.get_or_init(|| {
        let on = |k: &str, d: bool| std::env::var(k).map_or(d, |v| v != "0");
        Options {
            target: on("NONO_TARGET", true),
            modes: on("NONO_MODES", false),
            rephase: on("NONO_REPHASE", false),
            aux: on("NONO_AUX", false),
            lines: on("NONO_LINES", true),
            glucose: on("NONO_GLUCOSE", false),
            warmup: on("NONO_WARMUP", false),
            rootprobe: on("NONO_ROOTPROBE", false),
            share_clauses: on("NONO_SHARE_CLAUSES", false),
        }
    })
}

fn window_explanations() -> bool {
    static W: std::sync::OnceLock<bool> = std::sync::OnceLock::new();
    *W.get_or_init(|| std::env::var("NONO_WINDOW").is_ok_and(|v| v != "0"))
}

fn share_t0() -> bool {
    static T: std::sync::OnceLock<bool> = std::sync::OnceLock::new();
    *T.get_or_init(|| std::env::var("NONO_SHARE_T0").is_ok_and(|v| v != "0"))
}

fn verbose() -> bool {
    static V: std::sync::OnceLock<bool> = std::sync::OnceLock::new();
    *V.get_or_init(|| std::env::var("NONO_VERBOSE").is_ok_and(|v| v != "0"))
}

/// The portfolio's learning threads run different strategies, not just
/// different seeds: no single one wins everywhere. Measured on 2026-10-08:
/// target phases make Gettys 4× faster but never solve random 50% puzzles,
/// which need the block-position variables and no target phases.
/// 0: the configured default (target phases, cells only).
/// 1: block-position variables, line propagation, no target phases.
/// 2: as 1, plus probing at level 0 whenever the level-0 assignment grows.
/// 3, 5, 7, ...: as 1, with a perturbed seed (more block-position
/// threads; one seed can be 20x faster than another on the same puzzle).
/// 4, 6, ...: the default with a perturbed seed.
fn strategy(seed: u64) -> Options {
    let d = options();
    let on = |k: &str| std::env::var(k).is_ok_and(|v| v != "0");
    match seed {
        1 => Options {
            target: on("NONO_S1_TARGET"),
            modes: on("NONO_S1_MODES"),
            rephase: false,
            aux: true,
            lines: !on("NONO_S1_NOLINES"),
            glucose: d.glucose,
            warmup: d.warmup,
            rootprobe: d.rootprobe,
            share_clauses: d.share_clauses,
        },
        // Strategy 1 plus probing at level 0. Measured 2026-10-09 on random
        // 50x50/60x60 puzzles: often 2-3x faster than strategy 1, sometimes
        // 5x slower, so it runs next to strategy 1, not instead of it. (The
        // kissat-style core this slot held before added nothing measurable;
        // NONO_MODES etc. still reach it through the default strategy.)
        2 => Options {
            target: false,
            modes: false,
            rephase: false,
            aux: true,
            lines: true,
            glucose: d.glucose,
            warmup: d.warmup,
            rootprobe: true,
            share_clauses: d.share_clauses,
        },
        s if s >= 3 && s % 2 == 1 => strategy(1),
        _ => d,
    }
}

/// Reason-side bumping for learned clauses up to this many literals (0 off).
/// A conflict budget for measurements (NONO_MAX_CONFLICTS): the result
/// then does not depend on machine load.
fn max_conflicts() -> u64 {
    static M: std::sync::OnceLock<u64> = std::sync::OnceLock::new();
    *M.get_or_init(|| std::env::var("NONO_MAX_CONFLICTS").ok().and_then(|v| v.parse().ok()).unwrap_or(u64::MAX))
}

fn reason_bump() -> usize {
    static R: std::sync::OnceLock<usize> = std::sync::OnceLock::new();
    *R.get_or_init(|| std::env::var("NONO_REASON_BUMP").ok().and_then(|v| v.parse().ok()).unwrap_or(0))
}

/// Minimisation: 1 caches failures, 2 also tests levels first.
fn env_num<T: std::str::FromStr>(k: &str) -> Option<T> {
    std::env::var(k).ok().and_then(|v| v.parse().ok())
}

fn tiers() -> bool {
    static T: std::sync::OnceLock<bool> = std::sync::OnceLock::new();
    *T.get_or_init(|| std::env::var("NONO_TIERS").is_ok_and(|v| v != "0"))
}

fn minimise_all() -> bool {
    static M: std::sync::OnceLock<bool> = std::sync::OnceLock::new();
    *M.get_or_init(|| std::env::var("NONO_MINALL").map_or(true, |v| v != "0"))
}

fn luby(mut i: u64) -> u64 {
    // The Luby sequence 1 1 2 1 1 2 4 ... (i from 1).
    let mut k = 1u64;
    while (1u64 << k) - 1 < i {
        k += 1;
    }
    loop {
        if i == (1u64 << k) - 1 {
            return 1u64 << (k - 1);
        }
        i -= (1u64 << (k - 1)) - 1;
        k = 1;
        while (1u64 << k) - 1 < i {
            k += 1;
        }
    }
}

/// Count up to two solutions with learning. `root` holds cells already
/// settled (from probing); they become level-0 facts.
/// `seed` 0 is the plain solver. Other seeds diversify a portfolio thread:
/// a little random noise in the initial activities, a share of flipped
/// initial phases, and a different restart unit.
pub fn solve(
    p: &Puzzle,
    root: Option<&Grid>,
    limit_at: Option<Instant>,
    stop: Option<&AtomicBool>,
    seed: u64,
    facts: Option<&crate::solver::Facts>,
) -> Outcome {
    let mut seen_facts = 0u64;
    let mut probed_at = 0usize;
    let mut seen_clauses = 0usize;
    // With block-position variables: the order encoding's clauses next to
    // the line propagator, so learned rules can mention block positions.
    let opt = strategy(seed);
    let mut blocks = Vec::new();
    let ladder = env_num::<u8>("NONO_LADDER").unwrap_or(0) != 0;
    let bounds = opt.aux && env_num::<u8>("NONO_BOUNDS").unwrap_or(0) != 0;
    let encoded = opt.aux.then(|| {
        let rows: Vec<Vec<u32>> = (0..p.h).map(|l| p.clue(l).to_vec()).collect();
        let cols: Vec<Vec<u32>> = (0..p.w).map(|l| p.clue(p.h + l).to_vec()).collect();
        crate::cnf::encode_full(
            &rows,
            &cols,
            crate::cnf::chosen(),
            (ladder || bounds).then_some(&mut blocks),
            ladder,
            !bounds,
        )
    });
    let mut s = Solver::new(p, encoded.as_ref().map_or(0, |e| e.0));
    if !blocks.is_empty() {
        s.yblock = vec![u32::MAX; s.nv];
        s.yprev = vec![u32::MAX; blocks.len()];
        for (b, blk) in blocks.iter().enumerate() {
            for p in blk.lo..=blk.hi + 1 {
                s.yblock[(blk.base + p - blk.lo) as usize] = b as u32;
            }
            if let Some((nb, _)) = blk.next {
                s.yprev[nb as usize] = b as u32;
            }
        }
        s.blocks = blocks;
        s.ladder_on = ladder;
        if bounds {
            s.bounds = true;
            s.line_first = Vec::with_capacity(p.h + p.w);
            s.block_line = vec![0; s.blocks.len()];
            let mut b = 0u32;
            for line in 0..p.h + p.w {
                s.line_first.push(b);
                for _ in 0..p.clue(line).len() {
                    s.block_line[b as usize] = line as u32;
                    b += 1;
                }
            }
            s.ytrue = vec![0; s.blocks.len()];
            s.yfalse = vec![0; s.blocks.len()];
            // Every line once, with its bounds.
            s.dirty_rows = ones(p.h);
            s.dirty_cols = ones(p.w);
        }
    }
    // With block-position variables: shrinking, faster decay and
    // vivification. Measured 2026-10-09 on 72 random 40x40-60x60 puzzles,
    // strategy 1 alone, 100 000-conflict budget: 62/72 solved and PAR-2
    // 3.00M conflicts before, 67/72 and 1.81M after. The same settings made
    // strategy 0 slower (Gettys 4.7 -> 15.9 s in the portfolio), so it
    // keeps its own. NONO_SHRINK, NONO_DECAY and NONO_VIVIFY override both.
    // Linear-cost minimisation (`removable`), on the same 72 puzzles with
    // these settings: 67/72 -> 69/72 solved, PAR-2 1.81M -> 1.66M
    // conflicts, 17 % less time per conflict. On strategy 0 mixed (Thing
    // 2.3x faster, Gettys 2x slower), so it keeps level 1.
    // Re-tuned after the lean encoding (60 G-instruction budget): decay
    // 0.85 and 200 vivified clauses per round against 0.90 and 400, 72/72
    // against 71/72 solved, PAR-2 477 against 629 G on the tuning set; on
    // 48 unseen puzzles, two seeds, one more solved each and PAR-2 7-13 %
    // lower.
    if opt.aux {
        s.shrink = true;
        s.decay = 0.85;
        s.vivify_n = 200;
        s.minimise = 3;
        // Diversity for the portfolio (NONO_DIVERSE): strategy 3 keeps the
        // settings strategy 1 had before the re-tune.
        if seed == 3 && env_num::<u8>("NONO_DIVERSE").unwrap_or(0) != 0 {
            s.decay = 0.9;
            s.vivify_n = 400;
        }
    }
    if let Some(v) = env_num::<u8>("NONO_POISON") {
        s.minimise = v;
    }
    if let Some(v) = env_num::<u64>("NONO_SHRINK") {
        s.shrink = v != 0;
    }
    if let Some(v) = env_num::<f64>("NONO_DECAY") {
        s.decay = v;
    }
    if let Some(v) = env_num::<usize>("NONO_VIVIFY") {
        s.vivify_n = v;
    }
    s.lines = !(opt.aux && !opt.lines);
    if let Some((_, clauses)) = &encoded {
        let to_lit = |x: i64| lit((x.unsigned_abs() - 1) as usize, x < 0);
        for c in clauses {
            let lits: Vec<Lit> = c.iter().map(|&x| to_lit(x)).collect();
            if lits.len() == 1 {
                match s.lit_val(lits[0]) {
                    UNDEF => s.assign(lits[0], Reason::Decision),
                    0 => {
                        return Outcome { solutions: Vec::new(), timed_out: false, cancelled: false, stats: s.stats };
                    }
                    _ => {}
                }
            } else {
                s.add_clause(lits, false, 0);
            }
        }
    }
    let mut restart_unit = env_num::<u64>("NONO_RESTART_UNIT").unwrap_or(100);
    if seed >= 3 {
        let mut x = seed.wrapping_mul(0x9E37_79B9_7F4A_7C15) | 1;
        let mut rnd = move || {
            x ^= x << 13;
            x ^= x >> 7;
            x ^= x << 17;
            x
        };
        for v in 0..s.nv {
            s.activity[v] = (rnd() % 1000) as f64 * 1e-6;
            if rnd() % 100 < 20 {
                s.phase[v] ^= 1;
            }
        }
        s.heap.clear();
        s.heap_pos.iter_mut().for_each(|x| *x = -1);
        for v in 0..s.nv {
            s.heap_insert(v);
        }
        restart_unit = [100, 50, 200, 150][(seed % 4) as usize];
    }
    let mut sols: Vec<Grid> = Vec::new();
    let done = |s: Solver, sols: Vec<Grid>, timed_out: bool| Outcome {
        solutions: sols,
        timed_out,
        cancelled: false,
        stats: s.stats,
    };
    let stopped = || stop.is_some_and(|f| f.load(Relaxed));

    if let Some(g) = root {
        for line in 0..p.h {
            let (mut f, mut e) = (g.m[2 * line], g.m[2 * line + 1]);
            for (x, empty) in [(&mut f, false), (&mut e, true)] {
                while *x != 0 {
                    let c = x.trailing_zeros() as usize;
                    *x &= *x - 1;
                    let v = line * p.w + c;
                    if s.val[v] == UNDEF {
                        s.assign(lit(v, empty), Reason::Decision);
                    }
                }
            }
        }
    }
    if s.propagate().is_some() {
        return done(s, sols, false);
    }

    let start = Instant::now();
    if opt.warmup {
        s.warmup();
    }
    s.stable = opt.target && !opt.modes;
    s.consistent_targets = opt.modes;
    let mut mode_left = 1000u64;
    let mut mode_len = 1000u64;
    let mut rephase_at = 1000u64;
    let mut rephases = 0u64;
    let (mut ema_fast, mut ema_slow) = (0.0f64, 0.0f64);
    let mut restart_no = 1u64;
    let mut budget = restart_unit * luby(restart_no);
    let mut since_restart = 0u64;
    let mut next_reduce = 2000u64;
    let mut next_vivify = 2000u64;
    loop {
        let tp = Instant::now();
        let conflict = s.propagate();
        s.stats.propagate_ns += tp.elapsed().as_nanos() as u64;
        if let Some(c) = conflict {
            s.stats.conflicts += 1;
            since_restart += 1;
            if opt.target || opt.rephase {
                s.update_targets();
            }
            if s.decision_level() == 0 {
                return done(s, sols, false);
            }
            let ta = Instant::now();
            let (learnt, bt) = s.analyze(c);
            s.stats.analyze_ns += ta.elapsed().as_nanos() as u64;
            s.stats.learnt_lits += learnt.len() as u64;
            s.cancel_until(bt);
            if learnt.len() == 1 {
                // A unit learned before the first solution holds in every
                // solution; after it, the blocking clause takes part.
                let v = var(learnt[0]);
                if let (Some(f), true) = (facts, sols.is_empty() && v < s.ncell) {
                    f.publish_cell(p, v / p.w, v % p.w, learnt[0] & 1 == 0);
                }
                s.assign(learnt[0], Reason::Decision);
            } else {
                let lbd = s.lbd(&learnt);
                // Share short clauses over cells, learned before this
                // thread's first solution (after it, the blocking clause
                // can take part, and that holds only here).
                if let (Some(f), true) = (facts, opt.share_clauses && sols.is_empty() && learnt.len() <= 8) {
                    if learnt.iter().all(|&l| var(l) < s.ncell) {
                        f.export_clause(seed, &learnt);
                    }
                }
                // Glucose: moving averages of LBD, fast and slow.
                ema_fast += (lbd as f64 - ema_fast) / 32.0;
                ema_slow += (lbd as f64 - ema_slow) / 4096.0;
                let first = learnt[0];
                let cref = s.add_clause(learnt, true, lbd);
                s.assign(first, Reason::Clause(cref));
            }
            if verbose() && s.stats.conflicts.is_multiple_of(10_000) {
                eprintln!("[cdcl] {:.1} s: {} conflicts, {} solutions, best trail {}/{}, target {}, learned avg {:.0}, explain {:.1} s, {} restarts",
                    start.elapsed().as_secs_f64(), s.stats.conflicts, sols.len(), s.best_size, s.nv, s.target_size,
                    s.stats.learnt_lits as f64 / s.stats.conflicts as f64, s.stats.explain_ns as f64 / 1e9, s.stats.restarts);
            }
            if s.stats.conflicts.is_multiple_of(64) {
                if stopped() {
                    let mut o = done(s, sols, false);
                    o.cancelled = true;
                    return o;
                }
                if limit_at.is_some_and(|t| Instant::now() > t) || s.stats.conflicts >= max_conflicts() {
                    return done(s, sols, true);
                }
            }
            if s.stats.conflicts >= next_reduce {
                s.reduce_db();
                next_reduce += 2000 + 300 * (next_reduce / 2000);
            }
            continue;
        }
        if opt.modes && s.stats.conflicts >= mode_left {
            // Switch between focused and stable mode at growing intervals.
            s.stable = !s.stable;
            mode_len *= 2;
            mode_left = s.stats.conflicts + mode_len;
            s.target_size = 0;
            s.cancel_until(0);
            restart_no = 1;
            budget = if s.stable { 1024 } else { restart_unit } * luby(restart_no);
            since_restart = 0;
            continue;
        }
        if opt.rephase && s.stats.conflicts >= rephase_at {
            s.cancel_until(0);
            s.rephase(rephases);
            if opt.warmup {
                s.warmup();
            }
            rephases += 1;
            rephase_at = s.stats.conflicts + 1000 * (rephases + 1);
        }
        let glucose_due = opt.glucose && !s.stable && since_restart >= 50 && ema_fast > 1.25 * ema_slow;
        if glucose_due || (!(opt.glucose && !s.stable) && since_restart >= budget) {
            s.stats.restarts += 1;
            s.cancel_until(0);
            if s.vivify_n > 0 && s.stats.conflicts >= next_vivify {
                s.vivify(s.vivify_n);
                next_vivify = s.stats.conflicts + 2000;
                if s.unsat {
                    return done(s, sols, false);
                }
            }
            // Probing at level 0 (the probing search's strength): whenever the
            // level-0 assignment has grown since the last probe, run the full
            // probe sweep on it and keep every forced cell as a level-0 fact.
            if opt.rootprobe && s.trail.len() > probed_at {
                let mut g = s.to_grid();
                let mut memo = crate::solver::ProbeMemo::new(p);
                if let crate::solver::Probed::Contradiction = crate::solver::probe(p, &mut g, ones(p.h), &mut memo) {
                    return done(s, sols, false);
                }
                for r in 0..p.h {
                    for (o, empty) in [(0usize, false), (1, true)] {
                        let mut x = g.m[2 * r + o] & !if empty { s.e[r] } else { s.f[r] };
                        while x != 0 {
                            let c = x.trailing_zeros() as usize;
                            x &= x - 1;
                            let l = lit(r * p.w + c, empty);
                            if s.lit_val(l) == UNDEF {
                                s.assign(l, Reason::Decision);
                            }
                        }
                    }
                }
                if let (Some(f), true) = (facts, sols.is_empty()) {
                    f.publish(&g);
                }
                probed_at = s.trail.len();
                s.stats.root_probes += 1;
            }
            if let (Some(f), true) = (facts, opt.share_clauses && (seed != 0 || share_t0())) {
                if f.clause_count() > seen_clauses {
                    let (n, new) = f.clauses_since(seen_clauses, seed);
                    seen_clauses = n;
                    for c in new {
                        if c.iter().any(|&l| s.lit_val(l) == 1) {
                            continue; // satisfied at level 0
                        }
                        let rest: Vec<Lit> = c.into_iter().filter(|&l| s.lit_val(l) == UNDEF).collect();
                        match rest.len() {
                            0 => return done(s, sols, false), // no other solution
                            1 => s.assign(rest[0], Reason::Decision),
                            n => {
                                s.add_clause(rest, true, n as u32);
                                s.stats.imported += 1;
                            }
                        }
                    }
                }
            }
            // Strategy 0 publishes but does not import: imported facts at its
            // restarts made Gettys 2x slower and erratic (3-17 s, 8 runs).
            if let (Some(f), true) = (facts, seed != 0) {
                if f.version() != seen_facts {
                    let (v, m) = f.snapshot();
                    seen_facts = v;
                    for r in 0..p.h {
                        for (o, empty) in [(0usize, false), (1, true)] {
                            let mut x = m[2 * r + o];
                            while x != 0 {
                                let c = x.trailing_zeros() as usize;
                                x &= x - 1;
                                let l = lit(r * p.w + c, empty);
                                match s.lit_val(l) {
                                    UNDEF => s.assign(l, Reason::Decision),
                                    0 => return done(s, sols, false), // no other solution
                                    _ => {}
                                }
                            }
                        }
                    }
                }
            }
            restart_no += 1;
            budget = if s.stable && opt.modes { 1024 } else { restart_unit } * luby(restart_no);
            since_restart = 0;
            // The target is the longest trail since the last restart; with
            // modes, also in stable mode (kissat). Without modes the target
            // persists, which measured best for Gettys.
            if !s.stable || opt.modes {
                s.target_size = 0;
            }
            continue;
        }
        match s.pick() {
            Some(d) => {
                s.stats.decisions += 1;
                if s.stats.decisions.is_multiple_of(1024) && stopped() {
                    let mut o = done(s, sols, false);
                    o.cancelled = true;
                    return o;
                }
                s.trail_lim.push(s.trail.len());
                s.assign(d, Reason::Decision);
            }
            None => {
                // Every cell assigned with no conflict: a solution.
                if sols.is_empty() {
                    s.stats.first_solution_ns = start.elapsed().as_nanos() as u64;
                }
                sols.push(s.to_grid());
                if sols.len() >= 2 {
                    return done(s, sols, false);
                }
                let decisions: Vec<Lit> = s.trail_lim.iter().map(|&i| s.trail[i] ^ 1).collect();
                if decisions.is_empty() {
                    return done(s, sols, false);
                }
                // Forbid this solution's decisions; the last one flips.
                let top = s.decision_level();
                s.cancel_until(top - 1);
                let mut cl = decisions;
                let last = cl.pop().unwrap();
                cl.insert(0, last);
                if cl.len() == 1 {
                    s.cancel_until(0);
                    s.assign(cl[0], Reason::Decision);
                } else {
                    // The second watch must be the highest remaining level.
                    let n = cl.len();
                    cl.swap(1, n - 1);
                    let first = cl[0];
                    let cref = s.add_clause(cl, false, 0);
                    s.assign(first, Reason::Clause(cref));
                }
            }
        }
    }
}
