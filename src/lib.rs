//! Hugi: a fast nonogram solver, as a library (the command line is `src/main.rs`, the
//! web build is `web/`).
//!
//! `line` solves one row or column exactly with bit-parallel masks. `solver` propagates
//! over the grid, runs the probing search and the portfolio; `cdcl` is the learning
//! solver; `cnf` writes the puzzle as clauses; `format` reads and writes puzzles; `game` finds
//! the easiest next move and rates puzzles for the game mode.

// Index loops over parallel per-line arrays (clues, masks, candidate lists) read
// more clearly than iterator chains in this solver.
#![allow(clippy::needless_range_loop)]

pub mod cdcl;
pub mod clock;
pub mod cnf;
pub mod flow;
pub mod format;
pub mod game;
pub mod line;
pub mod solver;
