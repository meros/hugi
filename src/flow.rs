//! A global count check from discrete tomography.
//!
//! Without the block rule, a nonogram is the problem of filling cells so
//! that every row and column has the right number of filled cells, which
//! max-flow decides (Gale-Ryser). Line logic checks each line on its own;
//! this checks all of them together. Two uses:
//!
//! - No maximum flow fills every row: no solution below this node.
//! - In the residual graph of a maximum flow, an open cell whose row and
//!   column lie in different strongly connected components has the same
//!   value in every way of meeting the counts, so it is forced (the same
//!   reasoning as all-different filtering in constraint solvers).
//!
//! Rows and columns are nodes; every open cell is a unit edge from its row
//! to its column. Demands are fixed (every row and column must be met
//! exactly), so only cycles inside the bipartite part can change a flow.

use crate::line::Mask;

/// Forced cells as (row, col, filled), or None when the counts cannot be met.
pub fn propagate(
    h: usize,
    w: usize,
    row_need: &[u32],
    col_need: &[u32],
    open: &[Mask],
) -> Option<Vec<(usize, usize, bool)>> {
    let total: u32 = row_need.iter().sum();
    if total != col_need.iter().sum::<u32>() {
        return None;
    }
    // Greedy start, then augmenting paths (BFS) for the rest. flow[r] is
    // the mask of open cells in row r carrying flow.
    let mut flow = vec![0 as Mask; h];
    let mut rleft: Vec<u32> = row_need.to_vec();
    let mut cleft: Vec<u32> = col_need.to_vec();
    for r in 0..h {
        let mut x = open[r];
        while x != 0 && rleft[r] > 0 {
            let c = x.trailing_zeros() as usize;
            x &= x - 1;
            if cleft[c] > 0 {
                flow[r] |= 1 << c;
                rleft[r] -= 1;
                cleft[c] -= 1;
            }
        }
    }
    // Augment: from a row with demand left, alternate open-unused edges
    // (row -> col) and used edges back (col -> row), to a column with demand
    // left.
    let mut prev_col = vec![usize::MAX; w]; // row that reached column c
    let mut prev_row = vec![usize::MAX; h]; // column that reached row r
    for start in 0..h {
        while rleft[start] > 0 {
            prev_col.iter_mut().for_each(|x| *x = usize::MAX);
            prev_row.iter_mut().for_each(|x| *x = usize::MAX);
            let mut queue = vec![start];
            prev_row[start] = start;
            let mut end = None;
            let mut qi = 0;
            'bfs: while qi < queue.len() {
                let r = queue[qi];
                qi += 1;
                let mut x = open[r] & !flow[r];
                while x != 0 {
                    let c = x.trailing_zeros() as usize;
                    x &= x - 1;
                    if prev_col[c] != usize::MAX {
                        continue;
                    }
                    prev_col[c] = r;
                    if cleft[c] > 0 {
                        end = Some(c);
                        break 'bfs;
                    }
                    // Rows that send flow into c can give it up.
                    for r2 in 0..h {
                        if flow[r2] >> c & 1 == 1 && prev_row[r2] == usize::MAX {
                            prev_row[r2] = c;
                            queue.push(r2);
                        }
                    }
                }
            }
            let mut c = end?;
            cleft[c] -= 1;
            rleft[start] -= 1;
            loop {
                let r = prev_col[c];
                flow[r] |= 1 << c;
                if r == start {
                    break;
                }
                let c2 = prev_row[r];
                flow[r] &= !(1 << c2);
                c = c2;
            }
        }
    }
    // Strongly connected components of the residual graph on rows (0..h)
    // and columns (h..h+w): row -> col over open unused cells, col -> row
    // over used cells. Tarjan, iterative.
    let n = h + w;
    let succ = |v: usize, out: &mut Vec<usize>| {
        out.clear();
        if v < h {
            let mut x = open[v] & !flow[v];
            while x != 0 {
                out.push(h + x.trailing_zeros() as usize);
                x &= x - 1;
            }
        } else {
            let c = v - h;
            for r in 0..h {
                if flow[r] >> c & 1 == 1 {
                    out.push(r);
                }
            }
        }
    };
    let mut index = vec![usize::MAX; n];
    let mut low = vec![0usize; n];
    let mut comp = vec![usize::MAX; n];
    let mut on_stack = vec![false; n];
    let mut stack: Vec<usize> = Vec::new();
    let mut next_index = 0;
    let mut ncomp = 0;
    let mut buf = Vec::new();
    for root in 0..n {
        if index[root] != usize::MAX {
            continue;
        }
        // (node, its successors, position)
        let mut call: Vec<(usize, Vec<usize>, usize)> = Vec::new();
        index[root] = next_index;
        low[root] = next_index;
        next_index += 1;
        stack.push(root);
        on_stack[root] = true;
        succ(root, &mut buf);
        call.push((root, buf.clone(), 0));
        while let Some((v, ws, i)) = call.last_mut() {
            if *i < ws.len() {
                let u = ws[*i];
                *i += 1;
                if index[u] == usize::MAX {
                    index[u] = next_index;
                    low[u] = next_index;
                    next_index += 1;
                    stack.push(u);
                    on_stack[u] = true;
                    succ(u, &mut buf);
                    call.push((u, buf.clone(), 0));
                } else if on_stack[u] {
                    let lv = low[*v].min(index[u]);
                    low[*v] = lv;
                }
            } else {
                let v = *v;
                call.pop();
                if let Some((p, _, _)) = call.last() {
                    low[*p] = low[*p].min(low[v]);
                }
                if low[v] == index[v] {
                    loop {
                        let u = stack.pop().unwrap();
                        on_stack[u] = false;
                        comp[u] = ncomp;
                        if u == v {
                            break;
                        }
                    }
                    ncomp += 1;
                }
            }
        }
    }
    let mut forced = Vec::new();
    for r in 0..h {
        let mut x = open[r];
        while x != 0 {
            let c = x.trailing_zeros() as usize;
            x &= x - 1;
            if comp[r] != comp[h + c] {
                forced.push((r, c, flow[r] >> c & 1 == 1));
            }
        }
    }
    Some(forced)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Brute force over all fillings of the open cells: the forced cells are
    /// exactly those with one value in every filling that meets the counts.
    fn brute(h: usize, w: usize, rn: &[u32], cn: &[u32], open: &[Mask]) -> Option<Vec<(usize, usize, bool)>> {
        let cells: Vec<(usize, usize)> =
            (0..h).flat_map(|r| (0..w).filter(move |&c| open[r] >> c & 1 == 1).map(move |c| (r, c))).collect();
        let mut seen_on = vec![false; cells.len()];
        let mut seen_off = vec![false; cells.len()];
        let mut any = false;
        for m in 0u32..(1 << cells.len()) {
            let mut rc = vec![0u32; h];
            let mut cc = vec![0u32; w];
            for (k, &(r, c)) in cells.iter().enumerate() {
                if m >> k & 1 == 1 {
                    rc[r] += 1;
                    cc[c] += 1;
                }
            }
            if rc == rn && cc == cn {
                any = true;
                for k in 0..cells.len() {
                    if m >> k & 1 == 1 {
                        seen_on[k] = true
                    } else {
                        seen_off[k] = true
                    }
                }
            }
        }
        if !any {
            return None;
        }
        let mut out: Vec<_> = cells
            .iter()
            .enumerate()
            .filter(|&(k, _)| seen_on[k] != seen_off[k])
            .map(|(k, &(r, c))| (r, c, seen_on[k]))
            .collect();
        out.sort();
        Some(out)
    }

    #[test]
    fn matches_brute_force() {
        let mut x: u64 = 0x2545F4914F6CDD1D;
        let mut rnd = || {
            x ^= x << 13;
            x ^= x >> 7;
            x ^= x << 17;
            x
        };
        for _ in 0..3000 {
            let (h, w) = (1 + (rnd() % 4) as usize, 1 + (rnd() % 4) as usize);
            let open: Vec<Mask> = (0..h).map(|_| (rnd() as Mask) & ((1 << w) - 1)).collect();
            if open.iter().map(|m| m.count_ones()).sum::<u32>() > 14 {
                continue;
            }
            let rn: Vec<u32> = (0..h).map(|r| (rnd() % (open[r].count_ones() as u64 + 1)) as u32).collect();
            let cn: Vec<u32> = (0..w).map(|_| (rnd() % (h as u64 + 1)) as u32).collect();
            let mut got = propagate(h, w, &rn, &cn, &open);
            if let Some(g) = &mut got {
                g.sort();
            }
            assert_eq!(got, brute(h, w, &rn, &cn, &open), "h={h} w={w} rn={rn:?} cn={cn:?} open={open:?}");
        }
    }
}
