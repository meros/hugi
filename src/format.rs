//! Puzzle formats and small helpers shared by the command line and the web build:
//! reading clues (webpbn `.nin`, Simpson `.non`, Hugi's plain format), writing them
//! back, DIMACS, random puzzles and the JSON result.

use crate::solver::{self, Outcome, Puzzle};

/// The clues of a puzzle: one list per row, one list per column.
pub type Clues = (Vec<Vec<u32>>, Vec<Vec<u32>>);

pub fn parse(text: &str) -> Result<Puzzle, String> {
    let (rows, cols) = parse_clues(text)?;
    Ok(Puzzle::new(&rows, &cols))
}

/// webpbn's `.nin` export: "width height", then one clue per row, then one
/// per column; an empty line or 0 is a blank line.
pub fn parse_nin(text: &str) -> Option<Clues> {
    let mut lines = text.lines();
    let head: Vec<usize> = lines.next()?.split_whitespace().map(|x| x.parse().ok()).collect::<Option<_>>()?;
    let [w, h] = head[..] else { return None };
    let clue = |l: &str| -> Option<Vec<u32>> { l.split_whitespace().map(|x| x.parse().ok()).collect() };
    let body: Vec<Vec<u32>> = lines.take(h + w).map(clue).collect::<Option<_>>()?;
    if body.len() != h + w {
        return None;
    }
    let (rows, cols) = body.split_at(h);
    Some((rows.to_vec(), cols.to_vec()))
}

pub fn parse_clues(text: &str) -> Result<Clues, String> {
    if !text.contains("rows") {
        if let Some((rows, cols)) = parse_nin(text) {
            return check_clues(rows, cols);
        }
    }
    let mut rows = Vec::new();
    let mut cols = Vec::new();
    let mut in_cols: Option<bool> = None;
    for raw in text.lines() {
        let l = raw.split('#').next().unwrap().trim();
        if l.is_empty() {
            continue;
        }
        match l {
            "rows" => in_cols = Some(false),
            "cols" | "columns" => in_cols = Some(true),
            // Simpson's .non format: header and trailer lines such as
            // `width 40`, `title "..."` or `goal "..."` end a section.
            _ if l.starts_with(|c: char| c.is_ascii_alphabetic()) => in_cols = None,
            _ => {
                let clue: Vec<u32> = l
                    .split([' ', ','])
                    .filter(|x| !x.is_empty())
                    .map(|x| x.parse().map_err(|_| format!("bad number {x:?}")))
                    .collect::<Result<_, _>>()?;
                match in_cols.ok_or("clue before 'rows' or 'cols'")? {
                    false => rows.push(clue),
                    true => cols.push(clue),
                }
            }
        }
    }
    check_clues(rows, cols)
}

pub fn check_clues(rows: Vec<Vec<u32>>, cols: Vec<Vec<u32>>) -> Result<Clues, String> {
    let (h, w) = (rows.len(), cols.len());
    if h == 0 || w == 0 || h > 127 || w > 127 {
        return Err(format!("size {h}×{w}: need 1 to 127 rows and columns"));
    }
    let sum = |v: &Vec<Vec<u32>>| v.iter().flatten().map(|&x| x as u64).sum::<u64>();
    if sum(&rows) != sum(&cols) {
        return Err(format!("row clues fill {} cells, column clues {}", sum(&rows), sum(&cols)));
    }
    let strip = |v: Vec<Vec<u32>>| v.into_iter().map(|c| c.into_iter().filter(|&x| x > 0).collect()).collect();
    Ok((strip(rows), strip(cols)))
}

pub fn to_cnf(rows: &[Vec<u32>], cols: &[Vec<u32>]) -> String {
    let (nvars, clauses) = crate::cnf::encode(rows, cols, crate::cnf::chosen());
    let mut out = format!("p cnf {} {}\n", nvars, clauses.len());
    for c in clauses {
        for l in c {
            out += &l.to_string();
            out.push(' ');
        }
        out += "0\n";
    }
    out
}

pub fn runs(cells: impl Iterator<Item = bool>) -> Vec<u32> {
    let mut out = Vec::new();
    let mut k = 0;
    for c in cells.chain([false]) {
        if c {
            k += 1;
        } else if k > 0 {
            out.push(k);
            k = 0;
        }
    }
    out
}

/// A random picture as clues, for benchmarks. Random pictures are often
/// not unique and need search, which is what a benchmark should exercise.
pub fn generate(w: usize, h: usize, density: u64, seed: u64) -> (Vec<Vec<u32>>, Vec<Vec<u32>>) {
    let mut x = seed.wrapping_mul(0x9e3779b97f4a7c15) | 1;
    let mut cell = || {
        x ^= x << 13;
        x ^= x >> 7;
        x ^= x << 17;
        x % 100 < density
    };
    let pic: Vec<Vec<bool>> = (0..h).map(|_| (0..w).map(|_| cell()).collect()).collect();
    let rows = pic.iter().map(|r| runs(r.iter().copied())).collect();
    let cols = (0..w).map(|c| runs(pic.iter().map(|r| r[c]))).collect();
    (rows, cols)
}

pub fn to_text(rows: &[Vec<u32>], cols: &[Vec<u32>]) -> String {
    let line = |c: &Vec<u32>| {
        if c.is_empty() {
            "0".into()
        } else {
            c.iter().map(|v| v.to_string()).collect::<Vec<_>>().join(" ")
        }
    };
    let mut s = String::from("rows\n");
    rows.iter().for_each(|c| s += &(line(c) + "\n"));
    s += "cols\n";
    cols.iter().for_each(|c| s += &(line(c) + "\n"));
    s
}

/// The result as JSON for the UI (`hugi <puzzle> --json`): the solutions as
/// rows of '#' and '.', what solved it, and the counts behind it.
pub fn to_json(p: &Puzzle, o: &Outcome, secs: f64) -> String {
    let grid = |g: &solver::Grid| -> String {
        let rows: Vec<String> = (0..p.h)
            .map(|r| format!("\"{}\"", (0..p.w).map(|c| if g.filled(r, c) { '#' } else { '.' }).collect::<String>()))
            .collect();
        format!("[{}]", rows.join(","))
    };
    let unique = if o.timed_out {
        "null"
    } else if o.solutions.len() == 1 {
        "true"
    } else {
        "false"
    };
    format!(
        "{{\"width\":{},\"height\":{},\"seconds\":{:.6},\"timed_out\":{},\"unique\":{},\"engine\":\"{}\",\"threads\":{},\"root_known\":{},\"cells\":{},\"nodes\":{},\"conflicts\":{},\"restarts\":{},\"solutions\":[{}]}}",
        p.w, p.h, secs, o.timed_out, unique, o.engine, o.threads_used, o.root_known, p.w * p.h, o.nodes, o.conflicts, o.restarts,
        o.solutions.iter().map(grid).collect::<Vec<_>>().join(",")
    )
}
