//! The solver behind the game mode: the easiest next move for a board as it is, the rating
//! of a puzzle by replaying those moves from an empty grid, the tier that rating earns, and
//! the done/impossible status of every clue.
//!
//! The rules live in `docs/game-design.md` §2. Everything here is exact line logic
//! (`line::solve`, `line::feasible`) and probing on top of it; nothing calls the search.

use crate::format::{self, Clues};
use crate::line::{self, ones, Mask};
use std::collections::VecDeque;

/// Cell values in a state: what the page sends and what `rate` replays.
pub const UNKNOWN: u8 = 0;
pub const FILLED: u8 = 1;
pub const MARKED: u8 = 2;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Axis {
    Row,
    Col,
}

impl Axis {
    fn name(self) -> &'static str {
        match self {
            Axis::Row => "row",
            Axis::Col => "col",
        }
    }
}

/// The easiest deducible next move.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Move {
    /// One line has forced cells: `(row, col, value)` with value 1 filled, 0 empty.
    Line {
        axis: Axis,
        index: usize,
        open: usize,
        cells: Vec<(usize, usize, u8)>,
    },
    /// No line decides anything, but setting `cell` to the other value than `value` breaks line
    /// `axis`/`index` after `steps` line solves. So `cell` is `value`.
    Probe {
        cell: (usize, usize),
        value: u8,
        axis: Axis,
        index: usize,
        steps: usize,
    },
    /// The state breaks this line already.
    Contradiction {
        axis: Axis,
        index: usize,
    },
    /// No line move and no probe: the puzzle needs a guess here.
    None,
    Solved,
}

impl Move {
    pub fn json(&self) -> String {
        match self {
            Move::Line { axis, index, open, cells } => {
                let cells: Vec<String> = cells.iter().map(|(r, c, v)| format!("[{r},{c},{v}]")).collect();
                format!(
                    "{{\"kind\":\"line\",\"axis\":\"{}\",\"index\":{index},\"open\":{open},\"cells\":[{}]}}",
                    axis.name(),
                    cells.join(",")
                )
            }
            Move::Probe { cell: (r, c), value, axis, index, steps } => format!(
                "{{\"kind\":\"probe\",\"cell\":[{r},{c}],\"value\":{value},\"axis\":\"{}\",\"index\":{index},\"steps\":{steps}}}",
                axis.name()
            ),
            Move::Contradiction { axis, index } => {
                format!("{{\"kind\":\"contradiction\",\"axis\":\"{}\",\"index\":{index}}}", axis.name())
            }
            Move::None => "{\"kind\":\"none\"}".into(),
            Move::Solved => "{\"kind\":\"solved\"}".into(),
        }
    }
}

// ── The grid ────────────────────────────────────────────────────────────

/// What a probe's propagation came to.
enum Spread {
    /// A fixpoint, after this many line solves, without a contradiction.
    Settled,
    /// Line `line` has no placement, found by the `steps`-th line solve.
    Broke { line: usize, steps: usize },
    /// The propagation would not beat the cap, so it was given up.
    Capped,
}

/// Known cells as masks, rows first then columns: `m[2 * line]` filled, `m[2 * line + 1]` empty.
struct Lines<'a> {
    w: usize,
    h: usize,
    rows: &'a [Vec<u32>],
    cols: &'a [Vec<u32>],
    m: Vec<Mask>,
    /// Old values of `m` entries, newest last, so a probe can be undone.
    log: Vec<(usize, Mask)>,
}

impl<'a> Lines<'a> {
    fn new(rows: &'a [Vec<u32>], cols: &'a [Vec<u32>], state: &[u8]) -> Self {
        let (h, w) = (rows.len(), cols.len());
        let mut g = Lines { w, h, rows, cols, m: vec![0; 2 * (h + w)], log: Vec::new() };
        for r in 0..h {
            for c in 0..w {
                match state[r * w + c] {
                    FILLED => g.set(r, c, true),
                    MARKED => g.set(r, c, false),
                    _ => {}
                }
            }
        }
        g.log.clear();
        g
    }

    fn clue(&self, i: usize) -> &'a [u32] {
        if i < self.h {
            &self.rows[i]
        } else {
            &self.cols[i - self.h]
        }
    }

    fn len(&self, i: usize) -> usize {
        if i < self.h {
            self.w
        } else {
            self.h
        }
    }

    fn axis(&self, i: usize) -> (Axis, usize) {
        if i < self.h {
            (Axis::Row, i)
        } else {
            (Axis::Col, i - self.h)
        }
    }

    fn open(&self, i: usize) -> usize {
        self.len(i) - (self.m[2 * i] | self.m[2 * i + 1]).count_ones() as usize
    }

    fn set(&mut self, r: usize, c: usize, fill: bool) {
        let o = !fill as usize;
        for (i, bit) in [(2 * r + o, c), (2 * (self.h + c) + o, r)] {
            self.log.push((i, self.m[i]));
            self.m[i] |= 1 << bit;
        }
    }

    fn undo(&mut self) {
        while let Some((i, old)) = self.log.pop() {
            self.m[i] = old;
        }
    }

    fn solve_line(&self, i: usize) -> Option<(Mask, Mask)> {
        line::solve(self.len(i), self.clue(i), self.m[2 * i], self.m[2 * i + 1])
    }

    /// The cell of bit `k` in line `i`, and the line that crosses it there.
    fn cell(&self, i: usize, k: usize) -> ((usize, usize), usize) {
        if i < self.h {
            ((i, k), self.h + k)
        } else {
            ((k, i - self.h), k)
        }
    }

    /// Solve the lines in `dirty`, and every line that a new cell touches, until nothing
    /// changes, a line breaks, or the next solve would be number `cap` or more.
    fn propagate(&mut self, dirty: &[usize], cap: usize) -> Spread {
        let mut queue: VecDeque<usize> = dirty.iter().copied().collect();
        let mut queued = vec![false; self.h + self.w];
        dirty.iter().for_each(|&i| queued[i] = true);
        let mut steps = 0;
        while let Some(i) = queue.pop_front() {
            queued[i] = false;
            if steps + 1 >= cap {
                return Spread::Capped;
            }
            steps += 1;
            let Some((f, e)) = self.solve_line(i) else { return Spread::Broke { line: i, steps } };
            let (new_f, new_e) = (f & !self.m[2 * i], e & !self.m[2 * i + 1]);
            for (new, fill) in [(new_f, true), (new_e, false)] {
                let mut bits = new;
                while bits != 0 {
                    let k = bits.trailing_zeros() as usize;
                    bits &= bits - 1;
                    let ((r, c), cross) = self.cell(i, k);
                    self.set(r, c, fill);
                    if !queued[cross] {
                        queued[cross] = true;
                        queue.push_back(cross);
                    }
                }
            }
        }
        Spread::Settled
    }
}

/// The text of a game request: the clues, then a line `state`, then `h` lines of `w` characters,
/// `#` filled, `.` marked, `?` unknown. The state comes back as one value per cell, row-major.
/// The split comes first because `parse_clues` reads `#` as a comment.
pub fn parse_state(text: &str) -> Result<(Clues, Vec<u8>), String> {
    let lines: Vec<&str> = text.lines().collect();
    let at = lines.iter().position(|l| l.trim() == "state").ok_or("the text has no 'state' line")?;
    let (rows, cols) = format::parse_clues(&lines[..at].join("\n"))?;
    let (h, w) = (rows.len(), cols.len());
    let board: Vec<&str> = lines[at + 1..].iter().map(|l| l.trim()).filter(|l| !l.is_empty()).collect();
    if board.len() != h || board.iter().any(|l| l.chars().count() != w) {
        return Err(format!("the state must be {h} lines of {w} characters"));
    }
    let state = board
        .iter()
        .flat_map(|l| l.chars())
        .map(|ch| match ch {
            '#' => Ok(FILLED),
            '.' => Ok(MARKED),
            '?' => Ok(UNKNOWN),
            _ => Err(format!("bad state character {ch:?}")),
        })
        .collect::<Result<_, _>>()?;
    Ok(((rows, cols), state))
}

// ── The easiest move ────────────────────────────────────────────────────

/// The easiest deducible next move for `state` (one value per cell, row-major).
///
/// A line move comes first: the line with the largest share of its open cells forced, then the
/// one with fewer open cells, then rows before columns, then the lower index. When no line
/// forces a cell, a probe move: the unknown cell and value whose opposite breaks a line with the
/// fewest line solves.
pub fn next_move(rows: &[Vec<u32>], cols: &[Vec<u32>], state: &[u8]) -> Move {
    let mut g = Lines::new(rows, cols, state);
    let lines = g.h + g.w;
    // (new filled cells, new empty cells, open cells, line) of the best line so far.
    let mut best: Option<(Mask, Mask, usize, usize)> = None;
    for i in 0..lines {
        let Some((f, e)) = g.solve_line(i) else {
            let (axis, index) = g.axis(i);
            return Move::Contradiction { axis, index };
        };
        let (new_f, new_e) = (f & !g.m[2 * i], e & !g.m[2 * i + 1]);
        let (open, n) = (g.open(i), (new_f | new_e).count_ones() as usize);
        let better = best.is_none_or(|(bf, be, bo, _)| {
            let bn = (bf | be).count_ones() as usize;
            n * bo > bn * open || (n * bo == bn * open && open < bo)
        });
        if n > 0 && better {
            best = Some((new_f, new_e, open, i));
        }
    }
    if let Some((new_f, new_e, open, i)) = best {
        let (axis, index) = g.axis(i);
        let mut cells = Vec::new();
        for k in 0..g.len(i) {
            if (new_f | new_e) >> k & 1 == 1 {
                let ((r, c), _) = g.cell(i, k);
                cells.push((r, c, (new_f >> k & 1) as u8));
            }
        }
        return Move::Line { axis, index, open, cells };
    }
    if (0..g.h).all(|r| g.m[2 * r] | g.m[2 * r + 1] == ones(g.w)) {
        return Move::Solved;
    }
    probe(&mut g)
}

/// The probe move, for a state where no line forces a cell.
fn probe(g: &mut Lines) -> Move {
    let mut best: Option<Move> = None;
    let mut cap = usize::MAX;
    'scan: for r in 0..g.h {
        for c in 0..g.w {
            if (g.m[2 * r] | g.m[2 * r + 1]) >> c & 1 == 1 {
                continue;
            }
            for fill in [true, false] {
                g.set(r, c, fill);
                let spread = g.propagate(&[r, g.h + c], cap);
                g.undo();
                if let Spread::Broke { line, steps } = spread {
                    let (axis, index) = g.axis(line);
                    cap = steps;
                    best = Some(Move::Probe { cell: (r, c), value: !fill as u8, axis, index, steps });
                    // One solve is the least that a probe can cost.
                    if steps == 1 {
                        break 'scan;
                    }
                }
            }
        }
    }
    best.unwrap_or(Move::None)
}

// ── Status of the clues ─────────────────────────────────────────────────

/// Whether the filled cells in `mask` form exactly the runs of `clue`.
fn forms(mut mask: Mask, clue: &[u32]) -> bool {
    for &run in clue {
        if mask == 0 {
            return false;
        }
        mask >>= mask.trailing_zeros();
        let k = (!mask).trailing_zeros();
        if k != run {
            return false;
        }
        mask = mask.checked_shr(k).unwrap_or(0);
    }
    mask == 0
}

/// For every row and column: 0 open, 1 impossible (no placement of the clue fits the filled and
/// marked cells), 2 done (the filled cells already form the clue).
pub fn line_status(rows: &[Vec<u32>], cols: &[Vec<u32>], state: &[u8]) -> (Vec<u8>, Vec<u8>) {
    let g = Lines::new(rows, cols, state);
    let status: Vec<u8> = (0..g.h + g.w)
        .map(|i| {
            let (f, e) = (g.m[2 * i], g.m[2 * i + 1]);
            if !line::feasible(g.len(i), g.clue(i), f, e) {
                1
            } else if forms(f, g.clue(i)) {
                2
            } else {
                0
            }
        })
        .collect();
    (status[..g.h].to_vec(), status[g.h..].to_vec())
}

pub fn status_json(rows: &[Vec<u32>], cols: &[Vec<u32>], state: &[u8]) -> String {
    let (r, c) = line_status(rows, cols, state);
    let list = |v: &[u8]| v.iter().map(u8::to_string).collect::<Vec<_>>().join(",");
    format!("{{\"rows\":[{}],\"cols\":[{}]}}", list(&r), list(&c))
}

// ── Rating ──────────────────────────────────────────────────────────────

/// The length and the cost of the hint path of a puzzle.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Rating {
    /// Line moves applied.
    pub moves: usize,
    /// Probe moves applied, the most line solves one took, and the line solves of all of them.
    pub probes: usize,
    pub max_steps: usize,
    pub sum_steps: usize,
    /// The replay stopped on a move of kind `none`: the puzzle needs a guess.
    pub search: bool,
}

impl Rating {
    /// Orders puzzles inside a tier.
    pub fn effort(&self) -> usize {
        self.moves + 4 * self.probes + self.sum_steps.div_ceil(8)
    }
}

/// Apply `next_move` from an empty grid until the grid is full or the move is `none`. Returns
/// the rating and the grid reached.
fn replay(rows: &[Vec<u32>], cols: &[Vec<u32>]) -> Result<(Rating, Vec<u8>), String> {
    let w = cols.len();
    let mut state = vec![UNKNOWN; rows.len() * w];
    let mut rating = Rating { moves: 0, probes: 0, max_steps: 0, sum_steps: 0, search: false };
    loop {
        match next_move(rows, cols, &state) {
            Move::Line { cells, .. } => {
                rating.moves += 1;
                for (r, c, v) in cells {
                    state[r * w + c] = if v == 1 { FILLED } else { MARKED };
                }
            }
            Move::Probe { cell: (r, c), value, steps, .. } => {
                rating.probes += 1;
                rating.max_steps = rating.max_steps.max(steps);
                rating.sum_steps += steps;
                state[r * w + c] = if value == 1 { FILLED } else { MARKED };
            }
            Move::Contradiction { axis, index } => {
                return Err(format!("the clues have no solution: {} {index} breaks", axis.name()));
            }
            Move::None => {
                rating.search = true;
                return Ok((rating, state));
            }
            Move::Solved => return Ok((rating, state)),
        }
    }
}

pub fn rate(rows: &[Vec<u32>], cols: &[Vec<u32>]) -> Result<Rating, String> {
    replay(rows, cols).map(|(rating, _)| rating)
}

/// The lowest tier whose rule admits the puzzle, or `None` when it needs a guess or is larger
/// than 50 cells on a side.
pub fn tier(w: usize, h: usize, rating: &Rating) -> Option<&'static str> {
    // (name, largest side, most probes, most line solves in one probe)
    const TIERS: [(&str, usize, usize, usize); 5] = [
        ("tabby", 10, 0, 0),
        ("twill", 15, 0, 0),
        ("satin", 20, 3, 10),
        ("brocade", 30, 20, 25),
        ("tapestry", 50, usize::MAX, usize::MAX),
    ];
    if rating.search {
        return None;
    }
    let side = w.max(h);
    TIERS
        .iter()
        .find(|&&(_, s, probes, steps)| side <= s && rating.probes <= probes && rating.max_steps <= steps)
        .map(|t| t.0)
}

/// The rating as the JSON that `rate` returns. With `size` the object starts with `w` and `h`
/// (`hugi rate` prints that form).
pub fn rate_json(rows: &[Vec<u32>], cols: &[Vec<u32>], size: bool) -> Result<String, String> {
    let r = rate(rows, cols)?;
    let tier = tier(cols.len(), rows.len(), &r).map_or("null".to_string(), |t| format!("\"{t}\""));
    let head = if size { format!("\"w\":{},\"h\":{},", cols.len(), rows.len()) } else { String::new() };
    Ok(format!(
        "{{{head}\"moves\":{},\"probes\":{},\"max_steps\":{},\"sum_steps\":{},\"search\":{},\"effort\":{},\"tier\":{tier}}}",
        r.moves,
        r.probes,
        r.max_steps,
        r.sum_steps,
        r.search,
        r.effort()
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::format::{generate, parse_clues};
    use crate::solver::{self, Puzzle};

    fn clues(text: &str) -> Clues {
        parse_clues(text).unwrap()
    }

    fn rating_of(text: &str) -> (Rating, Option<&'static str>) {
        let (rows, cols) = clues(text);
        let r = rate(&rows, &cols).unwrap();
        let t = tier(cols.len(), rows.len(), &r);
        (r, t)
    }

    #[test]
    fn a_long_clue_forces_its_overlap() {
        // Ten columns of one cell each in two rows: only row 0 (clue 8) forces anything.
        let (rows, cols) = clues("rows\n8\n2\ncols\n1\n1\n1\n1\n1\n1\n1\n1\n1\n1\n");
        let state = vec![UNKNOWN; 20];
        let Move::Line { axis, index, open, cells } = next_move(&rows, &cols, &state) else { panic!("no line move") };
        assert_eq!((axis, index, open), (Axis::Row, 0, 10));
        assert_eq!(cells, (2..8).map(|c| (0, c, 1)).collect::<Vec<_>>());
    }

    #[test]
    fn a_line_finished_by_its_count_comes_first() {
        // Row 1 is empty (10 of 10 cells forced); row 0 forces 6 of 10.
        let (rows, cols) = clues("rows\n8\n0\n2\ncols\n1\n1\n1\n1\n1\n1\n1\n1\n1\n1\n");
        let state = vec![UNKNOWN; 30];
        let Move::Line { axis, index, open, cells } = next_move(&rows, &cols, &state) else { panic!("no line move") };
        assert_eq!((axis, index, open, cells.len()), (Axis::Row, 1, 10, 10));
        assert!(cells.iter().all(|&(r, _, v)| r == 1 && v == 0));
    }

    #[test]
    fn the_replay_of_the_repository_puzzles() {
        let (r, t) = rating_of(include_str!("../puzzles/hugi.txt"));
        assert_eq!((r.probes, r.max_steps, r.search, t), (1, 4, false, Some("brocade")));
        let (r, t) = rating_of(include_str!("../puzzles/heart.txt"));
        assert_eq!((r.moves, r.probes, t), (38, 0, Some("twill")));
        let (r, t) = rating_of(include_str!("../puzzles/rings.txt"));
        assert_eq!((r.search, t), (true, None));
    }

    #[test]
    fn a_probe_names_the_line_it_breaks() {
        let (rows, cols) = clues(include_str!("../puzzles/hugi.txt"));
        let mut state = vec![UNKNOWN; rows.len() * cols.len()];
        loop {
            match next_move(&rows, &cols, &state) {
                Move::Line { cells, .. } => {
                    cells.iter().for_each(|&(r, c, v)| state[r * cols.len() + c] = if v == 1 { FILLED } else { MARKED })
                }
                Move::Probe { cell, value, axis, index, steps } => {
                    // The opposite value breaks that line, in exactly that many solves.
                    let mut g = Lines::new(&rows, &cols, &state);
                    g.set(cell.0, cell.1, value == 0);
                    let dirty = [cell.0, rows.len() + cell.1];
                    let Spread::Broke { line, steps: s } = g.propagate(&dirty, usize::MAX) else { panic!("no break") };
                    assert_eq!((g.axis(line), s), ((axis, index), steps));
                    return;
                }
                other => panic!("expected a probe, got {other:?}"),
            }
        }
    }

    #[test]
    fn a_filled_cell_in_an_empty_row_is_a_contradiction() {
        let (rows, cols) = clues("rows\n0\n1\ncols\n1\n0\n");
        let mut state = vec![UNKNOWN; 4];
        assert_eq!(
            next_move(&rows, &cols, &state),
            Move::Line { axis: Axis::Row, index: 0, open: 2, cells: vec![(0, 0, 0), (0, 1, 0)] }
        );
        state[1] = FILLED;
        assert_eq!(next_move(&rows, &cols, &state), Move::Contradiction { axis: Axis::Row, index: 0 });
    }

    #[test]
    fn a_full_board_is_solved() {
        let (rows, cols) = clues("rows\n1\n1\ncols\n1\n1\n");
        // The 2×2 diagonal has two solutions, so it is stuck at the start; fill one.
        assert_eq!(next_move(&rows, &cols, &[UNKNOWN; 4]), Move::None);
        let state = [FILLED, MARKED, MARKED, FILLED];
        assert_eq!(next_move(&rows, &cols, &state), Move::Solved);
    }

    #[test]
    fn status_tells_done_from_impossible() {
        let (rows, cols) = clues("rows\n2 1\n3\n1 1\ncols\n2\n1\n1\n2\n2\n");
        // Row 0 is done (##.#.). Row 1 asks for 3 and has filled cells 5 apart. Row 2 is open.
        // Columns 0 and 1 are done; the others still wait for cells.
        let state: Vec<u8> = "##.#.#???#?????"
            .bytes()
            .map(|b| match b {
                b'#' => FILLED,
                b'.' => MARKED,
                _ => UNKNOWN,
            })
            .collect();
        assert_eq!(line_status(&rows, &cols, &state), (vec![2, 1, 0], vec![2, 2, 0, 0, 0]));
        assert_eq!(status_json(&rows, &cols, &state), "{\"rows\":[2,1,0],\"cols\":[2,2,0,0,0]}");
    }

    #[test]
    fn the_state_text_splits_at_the_state_line() {
        let ((rows, cols), state) = parse_state("rows\n3\n1 1\ncols\n1\n2\n1 1\nstate\n#??\n?.?").unwrap();
        assert_eq!((rows, cols), (vec![vec![3], vec![1, 1]], vec![vec![1], vec![2], vec![1, 1]]));
        assert_eq!(state, vec![FILLED, UNKNOWN, UNKNOWN, UNKNOWN, MARKED, UNKNOWN]);
        assert!(parse_state("rows\n1\ncols\n1\n").is_err());
        assert!(parse_state("rows\n1\ncols\n1\nstate\n##").is_err());
    }

    #[test]
    fn the_json_has_the_documented_shape() {
        let (rows, cols) = clues("rows\n8\n2\ncols\n1\n1\n1\n1\n1\n1\n1\n1\n1\n1\n");
        assert_eq!(
            next_move(&rows, &cols, &[UNKNOWN; 20]).json(),
            "{\"kind\":\"line\",\"axis\":\"row\",\"index\":0,\"open\":10,\"cells\":[[0,2,1],[0,3,1],[0,4,1],[0,5,1],[0,6,1],[0,7,1]]}"
        );
        assert_eq!(
            Move::Probe { cell: (7, 3), value: 0, axis: Axis::Col, index: 3, steps: 5 }.json(),
            "{\"kind\":\"probe\",\"cell\":[7,3],\"value\":0,\"axis\":\"col\",\"index\":3,\"steps\":5}"
        );
        assert_eq!(
            Move::Contradiction { axis: Axis::Row, index: 2 }.json(),
            "{\"kind\":\"contradiction\",\"axis\":\"row\",\"index\":2}"
        );
        let (rows, cols) = clues(include_str!("../puzzles/rings.txt"));
        assert!(rate_json(&rows, &cols, true).unwrap().starts_with("{\"w\":"));
        assert!(rate_json(&rows, &cols, false).unwrap().ends_with("\"tier\":null}"));
    }

    #[test]
    fn the_tier_rule() {
        let r = |probes, max_steps| Rating { moves: 10, probes, max_steps, sum_steps: max_steps, search: false };
        assert_eq!(tier(10, 10, &r(0, 0)), Some("tabby"));
        assert_eq!(tier(15, 5, &r(0, 0)), Some("twill"));
        assert_eq!(tier(5, 5, &r(1, 4)), Some("satin"));
        assert_eq!(tier(10, 10, &r(8, 7)), Some("brocade"));
        assert_eq!(tier(40, 40, &r(75, 90)), Some("tapestry"));
        assert_eq!(tier(51, 10, &r(0, 0)), None);
        assert_eq!(tier(5, 5, &Rating { search: true, ..r(0, 0) }), None);
    }

    /// From an empty grid, `next_move` alone reaches the solution of every unique puzzle that
    /// the replay does not give up on.
    #[test]
    fn the_replay_reaches_the_solution() {
        let (mut unique, mut guessed) = (0, 0);
        let mut seed = 0;
        while unique < 200 {
            assert!(seed < 20_000, "too few unique random puzzles");
            let (w, h) = (4 + seed as usize % 12, 4 + (seed as usize * 5) % 12);
            let (rows, cols) = generate(w, h, 55 + seed % 25, seed);
            seed += 1;
            let o = solver::solve(&Puzzle::new(&rows, &cols), 1);
            let [g] = &o.solutions[..] else { continue };
            unique += 1;
            let (rating, state) = replay(&rows, &cols).unwrap();
            if rating.search {
                guessed += 1;
                continue;
            }
            for r in 0..h {
                for c in 0..w {
                    assert_eq!(state[r * w + c] == FILLED, g.filled(r, c), "seed {} cell {r},{c}", seed - 1);
                }
            }
        }
        assert!(guessed < 200, "every puzzle needed a guess");
    }
}
