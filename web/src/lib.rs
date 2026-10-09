//! Hugi in the browser: a small C interface for WebAssembly, no wasm-bindgen.
//!
//! The page copies a puzzle (any format Hugi reads) into memory obtained from `alloc`, calls
//! `solve` with an engine number and reads the JSON result from `result_ptr`. One engine runs
//! per call on the calling thread; the page races several in separate Web Workers.

use hugi::format;
use hugi::solver::{self, Puzzle};
use std::cell::RefCell;

thread_local! {
    static RESULT: RefCell<Vec<u8>> = const { RefCell::new(Vec::new()) };
}

fn put(s: String) -> usize {
    RESULT.with(|r| {
        *r.borrow_mut() = s.into_bytes();
        r.borrow().len()
    })
}

fn input<'a>(ptr: *const u8, len: usize) -> Result<&'a str, String> {
    // SAFETY: the page passes a region it filled after `alloc(len)`.
    let bytes = unsafe { std::slice::from_raw_parts(ptr, len) };
    std::str::from_utf8(bytes).map_err(|_| "the puzzle is not valid UTF-8".to_string())
}

fn json_string(s: &str) -> String {
    let mut out = String::from("\"");
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

fn error(msg: &str) -> usize {
    put(format!("{{\"error\":{}}}", json_string(msg)))
}

/// Memory for the page to write a puzzle into.
#[no_mangle]
pub extern "C" fn alloc(len: usize) -> *mut u8 {
    let mut v = Vec::<u8>::with_capacity(len.max(1));
    let p = v.as_mut_ptr();
    std::mem::forget(v);
    p
}

/// Give that memory back.
///
/// # Safety
/// `ptr` must come from `alloc(len)` with the same `len`, and not be used afterwards.
#[no_mangle]
pub unsafe extern "C" fn dealloc(ptr: *mut u8, len: usize) {
    drop(Vec::from_raw_parts(ptr, 0, len.max(1)))
}

/// Where the last result is; its length is the return value of the call that made it.
#[no_mangle]
pub extern "C" fn result_ptr() -> *const u8 {
    RESULT.with(|r| r.borrow().as_ptr())
}

/// The clues of a puzzle as `{"rows":[[..],..],"cols":[[..],..]}`, or `{"error":".."}`.
#[no_mangle]
pub extern "C" fn clues(ptr: *const u8, len: usize) -> usize {
    let text = match input(ptr, len) {
        Ok(t) => t,
        Err(e) => return error(&e),
    };
    match format::parse_clues(text) {
        Ok((rows, cols)) => {
            let list = |v: &Vec<Vec<u32>>| {
                let items: Vec<String> = v
                    .iter()
                    .map(|c| format!("[{}]", c.iter().map(u32::to_string).collect::<Vec<_>>().join(",")))
                    .collect();
                format!("[{}]", items.join(","))
            };
            put(format!("{{\"rows\":{},\"cols\":{}}}", list(&rows), list(&cols)))
        }
        Err(e) => error(&e),
    }
}

/// Solve with one engine (see `hugi::solver::solve_engine`) and return the JSON result of
/// `hugi <puzzle> --json`, or `{"error":".."}`. The `seconds` field is 0: the page has the clock.
#[no_mangle]
pub extern "C" fn solve(ptr: *const u8, len: usize, engine: u32) -> usize {
    let text = match input(ptr, len) {
        Ok(t) => t,
        Err(e) => return error(&e),
    };
    let (rows, cols) = match format::parse_clues(text) {
        Ok(c) => c,
        Err(e) => return error(&e),
    };
    let p = Puzzle::new(&rows, &cols);
    let o = solver::solve_engine(&p, engine);
    put(format::to_json(&p, &o, 0.0))
}

/// The picture as rows of '#' (filled) and '.' (empty): its clues, solved with one engine.
fn solve_picture(pic: &[Vec<bool>], engine: u32) -> solver::Outcome {
    let rows: Vec<Vec<u32>> = pic.iter().map(|r| format::runs(r.iter().copied())).collect();
    let w = pic[0].len();
    let cols: Vec<Vec<u32>> = (0..w).map(|c| format::runs(pic.iter().map(|r| r[c]))).collect();
    solver::solve_engine(&Puzzle::new(&rows, &cols), engine)
}

/// The cells where two solutions of a puzzle with `h` rows and `w` columns differ.
fn differing(o: &solver::Outcome, h: usize, w: usize) -> Vec<(usize, usize)> {
    match (o.solutions.first(), o.solutions.get(1)) {
        (Some(a), Some(b)) => (0..h)
            .flat_map(|r| (0..w).map(move |c| (r, c)))
            .filter(|&(r, c)| a.filled(r, c) != b.filled(r, c))
            .collect(),
        _ => Vec::new(),
    }
}

/// One step of "make unique". The input is a picture, rows of '#' and '.' separated by newlines.
/// If the puzzle made from it has one solution the answer is `{"unique":true}`. Otherwise every
/// cell where two solutions differ is tried as a one-cell change of the picture, and the answer
/// names the change that leaves the fewest differing cells: `{"unique":false,"differ":n,
/// "flip":[row,col],"after":m}`, with `"flip":null` when no single change helps. A change that
/// makes the puzzle unique has `"after":0`.
#[no_mangle]
pub extern "C" fn make_unique_step(ptr: *const u8, len: usize, engine: u32) -> usize {
    let text = match input(ptr, len) {
        Ok(t) => t,
        Err(e) => return error(&e),
    };
    let mut pic: Vec<Vec<bool>> =
        text.lines().filter(|l| !l.is_empty()).map(|l| l.chars().map(|c| c == '#').collect()).collect();
    if pic.is_empty() || pic[0].is_empty() || pic.iter().any(|r| r.len() != pic[0].len()) {
        return error("the picture must be rows of the same length");
    }
    let (h, w) = (pic.len(), pic[0].len());
    let base = solve_picture(&pic, engine);
    if base.solutions.len() < 2 {
        return put("{\"unique\":true}".to_string());
    }
    let cells = differing(&base, h, w);
    let differ = cells.len();
    // At most 64 candidates, spread over the differing cells.
    let step = cells.len().div_ceil(64).max(1);
    let mut best: Option<((usize, usize), usize)> = None;
    for &(r, c) in cells.iter().step_by(step) {
        pic[r][c] = !pic[r][c];
        let o = solve_picture(&pic, engine);
        pic[r][c] = !pic[r][c];
        let after = if o.solutions.len() < 2 { 0 } else { differing(&o, h, w).len() };
        if best.is_none_or(|(_, b)| after < b) {
            best = Some(((r, c), after));
        }
        if after == 0 {
            break;
        }
    }
    match best {
        Some(((r, c), after)) if after < differ => {
            put(format!("{{\"unique\":false,\"differ\":{differ},\"flip\":[{r},{c}],\"after\":{after}}}"))
        }
        _ => put(format!("{{\"unique\":false,\"differ\":{differ},\"flip\":null,\"after\":{differ}}}")),
    }
}
