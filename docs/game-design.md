# Game mode: design

**In short.** The page gets a second mode, Play: 150 picture puzzles in five tiers from 5×5 to
50×50, a daily puzzle, and a quilt of solved pictures as the collection. Hints cost skeins (the
currency) and always show the easiest sure move for the board as it is. The WebAssembly solver
finds that move, rates every puzzle, and proved every puzzle unique offline. Progress stays in the
browser. A puzzle drawn in the Maker can be sent as a link to solve (§5b). Every old share
link still opens the Maker.

Limits, up front: there is no server, no account and no sound. The mistake check does not need
the solver: every puzzle ships with its one solution, so "wrong" is a comparison. Boards above
25×25 are playable on a phone but are meant for a large screen.

The numbers in this document come from a throwaway prototype (`hugi::line` only, the same
algorithm as specified in §2) run on 2026-10-12 on the owner's machine (Intel Core Ultra 7 258V,
generic x86-64 build) and from the existing `solve` export of `web/hugi_web.wasm` in Node 24.

## 1. Player experience

### The board

| input | does |
|---|---|
| left click or tap | apply the current tool (Fill by default) |
| right click | Mark, whatever the tool |
| drag | one stroke, locked to the row or column of the first cell once the pointer leaves it |
| Fill / Mark / Move buttons (keys `1`, `2`) | choose the tool; Move appears only when the board is wider than its frame |
| arrows | move the keyboard cursor |
| Space or Enter | Fill at the cursor; `X` or `.` marks |
| Shift + arrows | move and repeat the last action on the new cell (a keyboard drag) |
| `Z` or Ctrl+Z, `Y` or Ctrl+Y or Ctrl+Shift+Z | undo, redo (one stroke is one step; 500 steps kept) |
| Esc | leave pick mode, close a dialog |

**Stroke rule.** A stroke takes the value `v0` of its first cell and the tool value `t` (1 filled,
2 marked). It changes only the cells on its path whose value is `v0`, to `0` if `v0 == t`, else
to `t`. So a drag that starts on an empty cell fills empty cells and never overwrites a mark, and
a drag that starts on a filled cell clears filled cells. The path is every cell on the locked
axis between the start and the pointer, so a fast drag skips nothing.

**Look.** Unknown cells are the linen of `.board-wrap` (no fill). Filled cells are `tile()` from
`app.js` in `--t5` (ink) while the player works. A mark is a quiet dot: a filled circle of radius
`max(1.5, cell * 0.09)` in `--muted` at the cell centre. There are no crosses anywhere. Grid lines
and the bold line every 5 cells are the Maker's (`--line`, `--heavy`). The keyboard cursor is a
2 px `--stitch` rectangle inset 1 px, shown after the first key press and hidden on pointer use.
The minimum cell is 12 px on a pointer device and 14 px on touch. Below that the frame scrolls.

**Clues, free feedback.** After every stroke the page asks the solver for the status of each
line (`line_status`, §2):

- a line whose filled cells already form its clue exactly is *done*: its clue numbers are drawn
  in `--muted` at 55 % opacity;
- a line that no placement of its clue can fit, given its filled and marked cells, is
  *impossible*: its clue numbers are drawn in `--bad`.

This tells the player nothing they could not see themselves: it reads only their own cells and
the clue, never the solution. It is the free, always-on form of "you are wrong".

### Mistakes and winning

The board accepts any move and shows no mistake on its own. The player learns of one through the
free impossible-line colour above, the paid checks (§2c), or a hint, which points at a wrong cell
first (§2b). There are no lives: a wrong filled cell blocks the win, so a mistake costs time. The
puzzle is solved when the filled cells equal the solution; marks do not count. The page checks
after every stroke (a byte compare).

### The reveal

The finished picture is the reward, so the win animation makes it a picture:

1. marks fade out (250 ms), then grid lines and clues (300 ms);
2. each tile changes from `--t5` to the puzzle's own thread colour (`--t1`..`--t5`) and its margin
   goes to 0, so neighbouring tiles join into one shape. Tile (r, c) starts at
   `(r + c) * min(18, 1100 / (w + h))` ms and takes 160 ms: a diagonal wave from the top left,
   1.4 s at most;
3. the win card appears in the side panel: the picture's name (hidden until now) in 1.4rem bold
   serif, then `Twill · 15×15 · 4:12`, the stars, `+6 skeins`, and three buttons: **Next**,
   **Quilt**, **Save picture** (a PNG of the tiles on `--panel`, 16 px margin, cell
   `max(8, floor(512 / max(w, h)))`, file `hugi-<id>.png`).

With `prefers-reduced-motion: reduce` the board goes straight to the final state.

## 2. Solver-backed features

All new solver code lives in a new module `src/game.rs` of the `hugi` crate, so it can use
`line::solve` and `line::feasible` directly and has Rust unit tests. `web/src/lib.rs` adds three
thin exports in the existing style (text in through `alloc`, JSON out through `result_ptr`), and
`web/hugi.js` adds three wrappers. Nothing in `solver.rs` changes.

### The input text

`rate` takes a puzzle in Hugi's plain format (`rows`, one clue per line, `cols`, one per line),
as `puzzleText()` in `app.js` writes it. `hint` and `line_status` take the same text followed by
a line `state` and then `h` lines of `w` characters: `#` filled, `.` marked, `?` unknown. The
export splits at the first line that is exactly `state` before it calls `parse_clues`, because
`parse_clues` treats `#` as a comment. Example, a 2×3 board: `rows\n3\n1 1\ncols\n1\n2\n1 1\nstate\n#??\n?.?`.

### The easiest move (shared by hints and the rating)

`game::next_move(rows, cols, state) -> Move` is the single definition of "the easiest
deducible next move". In order:

1. **Line move.** Solve every row and column once with `line::solve` on its known cells. For each
   line where cells become forced, let `open` be its unknown cells before the move and `forced`
   the new cells. Take the line with the largest `forced / open`; ties go to the smaller `open`,
   then rows before columns, then the lower index. A line that is finished by its count
   (`forced == open`, such as a `0` row or a clue whose runs are all placed) therefore comes
   first, and a big overlap (`8` in 10 open cells, 6 forced) comes before a small one.
2. **Probe move**, only when no line has a forced cell. For each unknown cell in row-major order
   and each value (filled first), set it and propagate with full line logic, counting line
   solves. A contradiction after `s` solves proves the other value. Take the smallest `s`
   (propagation is capped at the best `s` so far, so the scan gets cheaper as it goes). Record
   the line where the contradiction appeared.
3. **None.** No line move and no probe: the puzzle needs a guess here. This never happens in the
   pack (§3), only in a puzzle shared from the Maker.

A state that already breaks a line returns `contradiction`. The page removes wrong cells before
it asks (§2b), so with a correct state this cannot happen; the case exists for the tests.

### New exports and their JSON

| export | input | output |
|---|---|---|
| `hint(ptr, len)` | clues + state | one `Move` as JSON |
| `line_status(ptr, len)` | clues + state | `{"rows":[0,2,1],"cols":[2,0,0]}`: 0 open, 1 impossible, 2 done |
| `rate(ptr, len)` | clues | the rating as JSON |

```json
{"kind":"line","axis":"row","index":4,"open":10,"cells":[[4,2,1],[4,3,1],[4,9,0]]}
{"kind":"probe","cell":[7,3],"value":0,"axis":"col","index":3,"steps":5}
{"kind":"contradiction","axis":"row","index":2}
{"kind":"none"}
{"kind":"solved"}
{"moves":43,"probes":8,"max_steps":7,"sum_steps":46,"search":false,"effort":81,"tier":"brocade"}
```

Cells are `[row, col, value]`, value 1 filled, 0 empty. In a probe, `value` is the proved value
of `cell`; the opposite value breaks line `axis`/`index` after `steps` line solves. Errors are
`{"error":"..."}` as in the existing exports. `hugi.js` gains
`hint: (text) => call("hint", text)`, `lineStatus: (text) => call("line_status", text)` and
`rate: (text) => call("rate", text)`.

### Costs

| operation | 50×50 | 100×100 | where it runs |
|---|---|---|---|
| line move (every line solved once) | ≤ 20 µs native | ≤ 0.19 ms native | worker |
| probe scan, only when no line move exists | ≤ 2.5 ms native | ≤ 83 ms native | worker |
| `line_status` (every line: `feasible`, run compare) | ≤ 20 µs native | ≤ 0.19 ms native | main thread |
| `rate` (the full hint replay, below) | ≤ 118 ms native on 50×50 icons | not measured; seconds for hard ones | worker, 5 s cap |
| one wasm call (copy, JSON) | 30 to 100 µs | | |

The wasm build ran 1.0 to 1.6 times the native time on 7 puzzles that take over 0.5 ms (existing
`solve` export, Node 24). So a hint costs at most 4 ms at 50×50 and 135 ms at 100×100 (only a
shared puzzle can be that large; the worker absorbs it).

### 2a. Mistake check

Every pack puzzle has exactly one solution, and the pack ships it (§3). So:

- **wrong cells** = filled where the solution is empty, plus marked where the solution is filled;
- **"is my state still solvable"** = "are there no wrong cells". With a unique solution, these
  are the same question, exactly.

Both are a loop over the cells in `web/game/hints.js`; the solver is not called. A puzzle from a
`#solve:` link is checked for uniqueness by the worker before play starts; §5b defines what
happens when it has several solutions.

### 2b. Hints

| hint | price | shows | counts as help |
|---|---|---|---|
| **Nudge** | 1 | where the easiest move is: the line band (line move), or the cell (probe move), highlighted until the next stroke | yes |
| **Show a cell** | 2 | sets one cell of the easiest move and outlines it | yes |
| **Reveal a line** | 5 | pick mode: the player clicks a row or column clue (keyboard: `R` row, `C` column through the cursor); every cell of it is set from the solution (filled, or marked) | yes |

**Wrong cells come first.** Before any hint, `hints.js` finds the wrong cells. If there is one,
the hint (at its normal price) outlines the most recently placed wrong cell (from the undo
stack; else the first in reading order) and says "This cell is wrong." Every deduction from a
wrong board would mislead, so this is the honest hint.

**Otherwise** `hints.js` sends the state to the worker's `hint` and acts on the `Move`:

| move | Nudge says | Show a cell sets |
|---|---|---|
| `line` | "Row 5 has a sure move." | the first forced filled cell of the line, else the first forced empty cell |
| `probe` | "Try this cell both ways: one of them breaks a line." | `cell` to `value`, and says "Filled, this cell would leave column 4 impossible. So it stays empty." |
| `none` | "No row or column decides anything here: this puzzle needs a guess." | the first unknown cell (reading order) that is filled in the solution |
| `solved` | nothing to show; the button is disabled when the board is won | |

Hint-set cells are normal cells: undo removes them (the help flag stays).

**Clue status is free.** "Show which clues are satisfied" is the done/impossible colouring of §1.
It reads only the player's own cells, so a price on it would be a tax on reading.

### 2c. Checks

| check | price | answer |
|---|---|---|
| **On track?** | 1 | "Yes, nothing you placed is wrong." or "No: something you placed is wrong." No location. |
| **Show mistakes** | 3 | outlines every wrong cell (2 px `--madder` dashed, `--madder-fill` behind, the Maker's style for differing cells) until the next stroke, and says "3 cells are wrong." |

Both count as help and answer from the solution (§2a).

### 2d. Difficulty rating

`game::rate(rows, cols)` replays the hint engine from an empty grid: it applies `next_move`
until the grid is full or the move is `none`. That makes the rating the length of the hint path,
and it proves that the hints alone can finish every puzzle in the pack. It counts:

- `moves`: line moves applied;
- `probes`: probe moves applied; `max_steps` and `sum_steps`: their line-solve counts;
- `search`: true when it stopped on `none`;
- `effort = moves + 4 * probes + ceil(sum_steps / 8)`: used only to order puzzles inside a tier.

`game::tier(w, h, &rating)` is the lowest tier whose rule admits the puzzle. It is the only place
the tier rule lives; the pack builder gets it through the CLI and the page through `rate`.

| tier | largest side | rule | the name |
|---|---|---|---|
| `tabby` | ≤ 10 | probes = 0 | the plain over-under weave |
| `twill` | ≤ 15 | probes = 0 | the diagonal weave |
| `satin` | ≤ 20 | probes ≤ 3, max_steps ≤ 10 | long floats |
| `brocade` | ≤ 30 | probes ≤ 20, max_steps ≤ 25 | a raised pattern |
| `tapestry` | ≤ 50 | search = false | the woven picture |

`search = true` gives `tier: null` ("needs a guess"); such puzzles stay out of the pack. A small
but hard puzzle moves up: the 10×10 paw print (8 probes, max 7 steps) is Brocade.

Measured on 30 Material Icons at 10, 15, 20, 30 and 40 cells: 131 of 150 need no guess; at 15×15,
24 of 30 are line logic alone. On 50×50 icons the replay took 0.2 to 118 ms native, with
0 to 75 probes.

## 3. Progression and the pack

### Size and order

| tier | puzzles | sizes | opens when |
|---|---|---|---|
| Tabby | 30 | 12 hand-drawn 5×5, 18 at 10×10 (smile among them) | at once |
| Twill | 30 | 15×15 (heart and house among them) | 20 Tabby solved |
| Satin | 30 | 20×20, plus smaller puzzles with up to 3 probes | 20 Twill solved |
| Brocade | 30 | 25×25 and 30×30, plus small hard ones (`hugi` 21×7, 1 probe) | 20 Satin solved |
| Tapestry | 30 | 20 at 40×40, 10 at 50×50 | 20 Brocade solved |

Every puzzle in an open tier can be played in any order; the quilt shows them in `effort` order,
numbered 1 to 150. "20 of 30" opens the next tier without demanding the hard third of each tier,
and the stars give a reason to come back. The first three 5×5 puzzles carry a one-line coach
note (`note` in the pack), for example "Each number is a run of filled cells, in order."

The five unique repository pictures join the pack: smile (Tabby), heart and house (Twill),
hugi (Brocade: 21 wide) and sierpinski (Tapestry: 32 wide). `rings` needs a guess and stays out.

### The daily puzzle

A separate pool of 60 puzzles (15×15 to 25×25, tiers Twill to Brocade, no picture shared with the
campaign) ships in the pack. The puzzle of a local calendar day `d` is
`daily[(dayNumber(d) * 37) % 60]`, where `dayNumber` counts local days from 2026-10-01 and 37 is
coprime with 60, so the order is a fixed permutation and consecutive days are far apart in the
pool. It needs no server. The daily opens after the first 5 campaign puzzles are solved. The pool
repeats after 60 days; a larger pool is a pack rebuild, not code.

### Where the pictures come from

Measured, not guessed: monochrome Noto Emoji was rejected (outline glyphs turn into broken lines
at 20×20, and flood-fill silhouettes leak through gaps). Filled **Material Icons** (Google,
Apache License 2.0) were kept: they are drawn on a 24-unit grid, read well at 10 to 50 cells, and
131 of 150 test renders needed no guess.

The 5×5 pictures are drawn by hand in `scripts/pack/small.txt` (12); the repository pictures come
from `scripts/make_examples.py`'s data; everything from 10×10 up is a Material Icon.

`scripts/pack/icons.tsv` is the curated list, about 350 rows:
`icon_name<TAB>Display name<TAB>thread` (thread 1 woad: sky, water, vehicles; 2 madder: food,
hearts, flowers; 3 weld: sun, light, music; 4 moss: plants, animals; 5 ink: buildings, tools).
Only pictures of things: no arrows, letters, UI controls or logos. Names are plain English
("Rabbit", not "cruelty_free").

**Rasterizing**, as tested: render the glyph at 960 px with Pillow, crop to the ink, centre it in
a square, shrink to n×n by area average (`Image.BOX`), and fill a cell when it is at least half
ink. Keep a render when 20 % to 80 % of its cells are filled.

**Selection.** `make_pack.py` renders every listed icon at 10, 15, 20, 25, 30, 40 and 50, pipes
the pictures to `hugi rate -` (§6), drops `tier: null`, then fills the slots of each tier with
puzzles spread evenly over the `effort` range of that tier's candidates (sort by effort, take
evenly spaced picks). An icon appears at most once in the whole pack. Same inputs give the same
bytes: no timestamps, sorted keys, fixed iteration order.

**Sources and licence.** The font and its name list are fetched at a pinned commit and checked:

| file | URL (commit `49d4db35df873165d6bd6ba09b063c7dafbac2f4` of google/material-design-icons) | sha256 |
|---|---|---|
| `font/MaterialIcons-Regular.ttf` | `https://raw.githubusercontent.com/google/material-design-icons/49d4db3.../font/MaterialIcons-Regular.ttf` | `ef149f08bdd2ff09a4e2c8573476b7b0f3fbb15b623954ade59899e7175bedda` |
| `font/MaterialIcons-Regular.codepoints` | same path, `.codepoints` | `530f25bf7b2d71c8e1da9476d53f9a9bb6b7e187bff69bb7128bb679b8194894` |

I downloaded these from `master` on 2026-10-12, when `master` was that commit; verify both
hashes on the first run. They go to `target/pack-cache/` (ignored by git). The pack carries the
credit line, and the README's Credits section and the game's footer repeat it.

### The pack file: `web/pack.json`

```json
{
  "version": 1,
  "credits": "Pictures of 10×10 and larger are made from Material Icons by Google (Apache License 2.0). The others are drawn for Hugi.",
  "tiers": [
    {"id": "tabby", "name": "Tabby", "blurb": "Small pictures, one line at a time.", "opens": 0},
    {"id": "twill", "name": "Twill", "blurb": "15×15, still line by line.", "opens": 20}
  ],
  "puzzles": [
    {"id": "cup-5", "name": "Cup", "w": 5, "h": 5, "bits": "b1Ew", "thread": 2, "tier": "tabby",
     "rating": {"moves": 9, "probes": 0, "max_steps": 0, "sum_steps": 0, "effort": 9},
     "note": "Each number is a run of filled cells, in order."}
  ],
  "daily": [{"id": "d-anchor-20", "name": "Anchor", "w": 20, "h": 20, "bits": "…", "thread": 1, "tier": "satin", "rating": {"…": 0}}]
}
```

(The `bits` values are placeholders.) `bits` is the solution in the Maker's share-link packing:
row-major, cell `i` is bit `i & 7` of byte `i >> 3`, base64url without padding. So a pack puzzle
and a share link hold a picture the same way. `puzzles` is in campaign order. `id` is
`<slug>-<size>` and never changes once published, because the save refers to it. The tier
`opens` value is the number of solved puzzles of the previous tier. Expected size: about 45 KB.

## 4. Gamification

**Skeins** (a skein is a loop of yarn) are the currency. The player starts with 5.

| earns | skeins |
|---|---|
| first solve of a pack puzzle | tier base (Tabby 2, Twill 3, Satin 4, Brocade 6, Tapestry 8) + stars |
| a replay that improves the stars | the extra stars only |
| the daily puzzle | 5 + min(streak, 5) |
| an achievement | 5 |
| a `#solve:` puzzle (§5b) | 0: anyone can make a trivial one; stars and best time are kept |

Prices: Nudge 1, On track? 1, Show a cell 2, Show mistakes 3, Reveal a line 5. One cheap hint per
puzzle is always affordable; leaning on hints means playing more.

**Stars**, best kept per puzzle: ★ solved; ★ solved without help (no hint and no check); ★ solved
within par. Par is `max(60, ceil30(cells * spc + 20 * probes))` seconds, with `spc` Tabby 2.0,
Twill 1.4, Satin 1.2, Brocade 1.1, Tapestry 1.0 seconds per cell and `ceil30` rounding up to 30 s:
5×5 is 1:00, 15×15 is 5:30, 50×50 is about 42 min. `par()` lives only in `rules.js`. These factors
are a first guess; calibrate them after the owner has played 10 puzzles per tier. The timer counts
only while the puzzle screen is visible (`visibilitychange`), starts at the first stroke, and is
saved with the board.

**Streak**: consecutive local days with the daily solved. Solving day `d` when the last daily was
`d - 1` adds one; any gap restarts at 1. Shown on the daily card.

**The quilt is the collection.** The Play screen shows each tier as a quilt of patches, one per
puzzle. An unsolved patch is blank linen with its number and size; a solved patch is its picture
in its thread colour. A finished tier is a finished quilt. Collecting pictures is the main hook,
so the list of levels and the gallery are the same screen.

**Achievements** (8, each +5 skeins):

| id | name | earned by |
|---|---|---|
| `first` | First stitch | solve a puzzle |
| `unaided` | Unaided | solve a puzzle of 15×15 or larger without help |
| `brisk` | Brisk | earn the par star on 10 puzzles |
| `quilt` | Quilter | solve every puzzle in one tier |
| `week` | A week of thought | a daily streak of 7 |
| `hugi` | Faster than action | solve a Tapestry puzzle within par and without help |
| `fine` | Fine work | three stars on 25 puzzles |
| `own` | A gift | solve a puzzle someone shared with you (a `#solve:` link) |

### The save: `localStorage["hugi-game"]`

```json
{
  "v": 1,
  "skeins": 17,
  "solved": {"cup-5": {"stars": 3, "best": 41, "first": "2026-10-12"}},
  "progress": {"pets-15": {"cells": "AAoA…", "seconds": 95, "helped": false, "at": 1760270400000}},
  "daily": {"last": "2026-10-12", "streak": 3, "best": 5},
  "ach": {"first": "2026-10-12"},
  "stats": {"parStars": 4, "threeStars": 2, "hints": 3, "checks": 1},
  "shared": {},
  "settings": {}
}
```

- `progress[id].cells`: 2 bits per cell (0 unknown, 1 filled, 2 marked), cell `i` in bits
  `2*(i&3)` of byte `i>>2`, base64url. At most 10 entries; the oldest `at` goes first. Dates are
  local `YYYY-MM-DD`; `best` is seconds. Every storage access is in try/catch.
- `loadSave()`: missing or unreadable JSON gives a fresh save (an unreadable value is kept once
  under `hugi-game-broken`); a `v` above the known one opens read-only with a note; older
  versions pass through `MIGRATIONS[v]` in order.
- **Your progress** dialog: **Download save** (`hugi-save-YYYY-MM-DD.json`, the save pretty
  printed), **Load save** (file or pasted text; validated; it replaces the current save after a
  confirm that names both picture counts), **Start over** (confirm).

The existing keys `hugi-theme`, `hugi-thread` and `hugi-picture` stay as they are.

## 5. Information architecture

**One page, routes by hash.** `web/game/main.js` owns a `hashchange` router. It sets
`document.body.dataset.view` and dispatches `hugi:route` on `document`.

| hash | view |
|---|---|
| empty, `#play` | Play: the quilt |
| `#play/<id>` | a pack puzzle |
| `#daily` | today's daily puzzle (the hash stays `#daily`) |
| `#solve:WxH:bits[&t=…&a=…]` | a picture shared from the Maker, as a puzzle to solve (§5b) |
| `#make`, `#WxH:bits` | the Maker; every existing share link keeps working |

The front door changes from the Maker to Play, because the game is the new main product and a new
visitor should meet a puzzle first. The Maker is one click away in the header.

**Header**: `Hugi`, a `<nav>` with **Play** and **Make** (`aria-current="page"` on the active one),
and on the right the skein count (Play views only), the theme button and the GitHub link.

**Maker additions**: the **Share…** dialog of §5b.

**Play screen**: the daily card (size, tier, streak, Play button, or "Solved today"), the skein
count, **Achievements** and **Your progress** buttons, then one section per tier: heading, blurb,
`12 of 30`, and the quilt grid (`repeat(auto-fill, minmax(64px, 1fr))`, gap 6 px). A patch is a
`<button>` with a canvas. Unsolved: `--panel`, 2 px dashed `--heavy` border, radius 8 px, number
and size in `--muted`. In progress: the dashed border in `--stitch`. Solved: the picture with
`tile()` in its thread colour, solid `--heavy` border, stars under it in `--t3`. A locked tier is
at 45 % opacity, not focusable, with "Opens when you solve 20 Twill puzzles (12 so far)."

**Puzzle screen**: the Maker's two-column grid (`minmax(0, 1fr) 21.5rem`, one column under
860 px). Left: `.board-wrap` with the board canvas. Right: an `<aside>` (the Maker's panel look)
with the title (`Puzzle 17 · 15×15 · Twill`), the timer and par, the tool buttons, Undo, Redo,
**Restart**, the Help section (buttons with their prices; disabled with a title when skeins are
short), the skein balance and the message line. Under 860 px the tool row (Fill, Mark, Move, Undo,
Redo) is `position: sticky; bottom: 0` so a thumb reaches it.

**Phones**: boards up to 25×25 fit a 360 px screen at about 13 px cells. Larger boards keep 14 px
cells and the frame scrolls; the Move tool sets `touch-action: pan-x pan-y` on the canvas so one
finger scrolls, and Fill and Mark set it back to `none`. The quilt marks Tapestry "best on a
large screen".

**Accessibility**: the canvas has `role="application"`, an `aria-label`, and keyboard play (§1).
An `aria-live="polite"` line announces the cursor cell after each move ("Row 3, column 5, empty.
Row clue 2 1. Column clue 4."), every hint and check, and the win. All buttons are real buttons
with visible focus (the existing `outline: 3px solid var(--stitch)`). Toasts use `role="status"`.
`prefers-reduced-motion` turns off the reveal wave and toast movement.

**Themes**: everything takes its colour from the existing CSS variables. Canvases read them
through `css()` at draw time and redraw on a `hugi:theme` event that `applyTheme()` in `app.js`
dispatches. New variables, in all three theme blocks: `--hint-fill` (day
`rgba(46, 74, 115, .14)`, night `rgba(122, 162, 224, .18)`).

**Sound**: none; a silent page is the expected default.

## 5b. Sharing from the Maker to the game

A player draws a puzzle in the Maker and sends a link. The recipient opens it in Play as a puzzle
to solve: clues only, the picture hidden, with the same board, hints, checks and stars as a pack
puzzle. It earns stars and a place on a "Shared with me" shelf. It earns no skeins.

### The link

| link | opens |
|---|---|
| `#WxH:bits` (today's format, unchanged) | the Maker, to edit |
| `#solve:WxH:bits` | Play, to solve |
| `#solve:WxH:bits&t=<title>&a=<author>` | the same, with a title and an author name |

- `W`, `H`, `bits` are exactly today's share link (`packBits`), so `#solve:` is the edit link with
  a prefix. The prefix is what tells "solve this" from "edit this". The page never guesses.
- `t` and `a` are optional, `encodeURIComponent`-encoded, at most 40 characters each after
  decoding (longer is cut), and shown only through `textContent`. base64url has no `&`, so the
  parser splits on `&` after the bits. Unknown keys are ignored, so later fields (`&v=2`) do not
  break old pages.
- The picture travels in the link. A recipient who decodes the link can see the answer; that is
  accepted, as for any puzzle you send a friend.
- Sizes 1×1 to 100×100, as in the Maker. A board above 50×50 shows "best on a large screen".

### What the Maker offers

**Copy link** becomes **Share…**, which opens a small dialog:

- **Link to solve** (the main button): copies `#solve:` with the title and the name. It is enabled
  only when the verdict is "Unique solution". Otherwise it is disabled and the dialog says "This
  picture has more than one solution. Use Make unique first, or share it to edit." and shows the
  **Make unique** button.
- **Title** (empty by default) and **Your name** (remembered in `localStorage["hugi-author"]`)
  fields above it.
- **Link to edit**: copies today's `#WxH:bits` link, as Copy link does now.
- **Solve it yourself**: opens the solve link in this tab, to test it.

### Uniqueness

The Maker shares a solve link only for a unique picture. A link made by hand (or by an older page)
can still carry a picture with several solutions, so the recipient's page checks again: the game
worker runs engine 2 with a 5 s cap before the board opens (the board shows "Checking the puzzle…").

- **Unique**: a normal puzzle. The checks of §2a compare against the picture.
- **Several solutions**: the puzzle opens with a note in the side panel, "This puzzle has more than
  one solution. Any picture that fits every clue counts." Then:
  - the win is "every row and column matches its clue" (`line_status` all 2), not "equals the
    picture";
  - **On track?**, **Show mistakes**, **Reveal a line** and the wrong-cell-first rule are hidden,
    because "wrong" has no meaning when two answers are right;
  - **Nudge** and **Show a cell** stay: every `line` and `probe` move holds in every solution, so
    they are still true. A `none` move only says "this puzzle needs a guess here"; it reveals
    nothing;
  - the free clue colouring of §1 is the only mistake signal.
- **Timeout** (no answer in 5 s): treated as unique, with the note "Hugi could not finish checking
  this puzzle." This only happens for large, hard pictures.

For every puzzle, unique or not, the win test is "every line matches its clue". With one solution
this is the same as "equals the picture" (§1), so one rule serves both.

The worker's `rate` gives the tier and par (5 s cap; on timeout the tier is Tapestry and par is
computed with 0 probes).

### Storage and rewards

The shared puzzle's id is `s-` plus the FNV-1a 32-bit hash, in hex, of `WxH:bits`, so the same
picture has the same id whatever its title. It is stored in a new save field (save `v` stays 1;
`loadSave` adds an empty `shared` when it is missing):

```json
"shared": {"s-9f3a12c4": {"w": 15, "h": 15, "bits": "…", "title": "Rabbit", "author": "Ann",
                          "unique": true, "stars": 2, "best": 301, "first": "2026-10-12", "at": 1760270400000}}
```

- At most 100 entries; the oldest `at` goes first. The board in progress uses `progress[id]` as
  pack puzzles do.
- **The shelf**: the Play screen ends with a "Shared with me" section, a quilt like the tiers: one
  patch per stored puzzle, solved or not, labelled with its title (or "Untitled") and "from Ann".
  A patch opens its `#solve:` link again. It is not part of the 150, does not open tiers, and
  does not count for the Quilter achievement.
- **Rewards**: stars and best time, as for a pack puzzle. **0 skeins**, because anyone can make a
  trivial puzzle in seconds. Hints cost skeins as usual. The achievement `own` (renamed "A gift":
  solve a puzzle someone shared with you) pays its 5 skeins once.

### Code

`web/game/shared.js` (WP9):

```js
export function solveLink({w, h, cells, title, author}): string  // "#solve:WxH:bits&t=…&a=…"
export function parseSolveLink(hash): {w, h, bits, cells, title, author} | null  // null for anything else
export function sharedId(w, h, bits): string                     // "s-" + FNV-1a hex
export function sharedPuzzle(link, {unique, rating}): Puzzle     // kind "shared"; name = title or "Untitled"
```

This replaces `sharedPuzzle` in `pack.js`. The router sends `#solve:` to the puzzle screen with
the parsed link; `play.js` asks `engine.unique` and `engine.rate`, then loads the board.

## 6. Code architecture

### Files

| WP | files and their role |
|---|---|
| WP1 | `src/game.rs` (`next_move`, `rate`, `tier`, `line_status`, tests); `src/lib.rs` (`pub mod game;`); `src/main.rs` (`hugi rate <file or ->`); `web/src/lib.rs` (exports `hint`, `line_status`, `rate`); `web/hugi.js` (wrappers); `web/test/wasm.test.mjs` |
| WP2 | `web/grid.js` (clue and packing helpers, moved from `app.js`); `web/draw.js` (`css`, `tile`, `dot`); `web/wasm.js` (one compile for Maker and game); `web/index.html` (nav, view containers, stylesheet links, `--hint-fill`, `#board-wrap` styles become `.board-wrap`); `web/app.js` (imports, view guards); `web/game/main.js` (router, boot, screens); `web/game/game.css` (nav, shared components, dialogs, toasts); both workflows |
| WP3 | `scripts/make_pack.py`, `scripts/pack/icons.tsv`, `scripts/pack/small.txt`, `web/pack.json` |
| WP4 | `web/game/rules.js`, `save.js`, `pack.js`: pure logic |
| WP5 | `web/game/board.js`: the play canvas |
| WP6 | `web/game/worker.js`, `engine.js`, `hints.js`: solver calls and the hint policy |
| WP7a | `web/game/quilt.js`, `quilt.css`, `dialogs.js`: Play screen, achievements, progress dialog |
| WP7b | `web/game/play.js`, `play.css`: puzzle screen, timer, win |
| WP9 | `web/game/shared.js`: solve links, ids; then the Share… dialog, the shelf and the several-solutions mode in the files above (§5b) |

`app.js` keeps the Maker and nothing else. The game never imports `app.js`. They meet in the
DOM (`body.dataset.view`, the `hugi:route` and `hugi:theme` events) and in the shared modules.

### Interfaces

```js
// Types (JSDoc in the code)
// Puzzle: {id, name, w, h, solution: Uint8Array /* 1 filled */, rows, cols, thread, tier, rating, note?, kind: "pack"|"daily"|"shared"}
// State: Uint8Array of w*h, 0 unknown, 1 filled, 2 marked.  Move: the hint JSON of §2.

// web/grid.js
export function runs(cells): number[]
export function cluesOf(w, h, cells): {rows: number[][], cols: number[][]}
export function cluesText({rows, cols}): string             // Hugi plain format, "0" for an empty line
export function stateText(w, h, state): string              // "state\n" + rows of # . ?
export function packBits(w, h, cells): string               // the share-link packing, byte-compatible with today's app.js
export function unpackBits(w, h, s): Uint8Array

// web/draw.js
export const css = (name) => string                          // as in app.js today
export function tile(ctx, px, py, cell, color, margin = null) // app.js's tile(); margin overrides for the reveal
export function dot(ctx, px, py, cell, color)                // the mark

// web/wasm.js
export function loadSolver(): Promise<{module: WebAssembly.Module, hugi}>  // memoized; fetch("hugi_web.wasm?v=dev")

// web/game/main.js
export function registerScreen(view, {show(params), hide()})   // views: "play", "puzzle"
export function go(hash)                                       // sets location.hash
export const ctx = {pack, save, solver, engine}                // filled during boot

// web/game/pack.js
export async function loadPack(): Promise<Pack>   // fetch("pack.json?v=dev"); Pack {version, credits, tiers, puzzles, daily, byId: Map}
export function dailyFor(pack, date = new Date()): {puzzle, day /* "YYYY-MM-DD" */}
export function tierState(pack, save, tierId): {open: boolean, solved: number, need: number}
export function nextPuzzle(pack, save, afterId): Puzzle | null   // next unsolved in an open tier

// web/game/rules.js (pure)
export const PRICES = {nudge: 1, cell: 2, line: 5, track: 1, mistakes: 3}
export const START_SKEINS = 5
export function par(puzzle): number
export function stars({seconds, helped, par}): 1 | 2 | 3
export function reward({puzzle, stars, prevStars, streak}): number
export const ACHIEVEMENTS: {id, name, text}[]
export function earnedAchievements(save, solveEvent): string[]   // ids not yet in save.ach

// web/game/save.js
export function loadSave(): Save
export function writeSave(save): void
export function freshSave(): Save
export function exportSave(save): string
export function importSave(text): Save | {error: string}
export function recordSolve(save, {puzzle, seconds, helped, day}): {stars, earned, newAch: string[]}  // mutates save
export function spend(save, amount): boolean
export function getProgress(save, id) / putProgress(save, id, {state, seconds, helped}) / clearProgress(save, id)
export function packState(state): string / unpackState(n, s): Uint8Array

// web/game/board.js
export class Board extends EventTarget {
  constructor(canvas, wrap)
  load(puzzle, state?)                       // a fresh board or a saved one
  get state()                                // Uint8Array (do not mutate)
  tool                                       // "fill" | "mark" | "move"
  undo(); redo(); get canUndo(); get canRedo()
  setCells(list /* [{i, v}] */)              // one undo step, used by hints
  highlight({lines = [], cells = []})        // lines: [{axis, index}], cells: [{i, style: "hint"|"wrong"}]; cleared by the next stroke
  setLineStatus({rows, cols})
  reveal(solution, color): Promise<void>     // §1; resolves at the end
  draw()
  // events: "stroke" {detail: {changed: number[]}} after a stroke, undo, redo or setCells; "cursor" {detail: {r, c}}
}
export function strokePath(start, end, w): number[]          // pure: axis-locked cells from start to end
export function applyStroke(state, path, tool): {i, from, to}[] // pure: the stroke rule of §1

// web/game/engine.js
export class Engine {
  constructor(module)                         // one worker: new Worker("game/worker.js?v=dev", {type: "module"})
  hint(puzzle, state): Promise<Move>
  rate(puzzle): Promise<Rating | {timeout: true}>      // 5 s, then the worker is replaced
  unique(puzzle): Promise<true | false | null>         // engine 2; null on timeout (5 s)
}
export function lineStatus(hugi, puzzle, state): {rows, cols}   // sync, main-thread instance

// web/game/worker.js: {id, op: "init", module} instantiates once; then
// {id, op: "hint" | "rate" | "solve", text, engine?} answers {id, result} or {id, error}.

// web/game/hints.js
export function wrongCells(puzzle, state): number[]
export async function runHint(kind /* "nudge"|"cell"|"line"|"track"|"mistakes" */, {puzzle, state, engine, lastWrong, pick}): Promise<{
  set: {i, v}[], highlight: {lines, cells}, message: string }>
```
`runHint` does not touch skeins; `play.js` spends first (`spend`) and refunds nothing, because
every hint returns something.

### Workers

The Maker keeps its race of three engines (`worker.js`, engines 2, 0, 1), unchanged. The game
uses one long-lived worker: hints cost milliseconds and are asked one at a time, so a race would
only add start-up (a worker plus an instantiate per call today). The game worker instantiates the
shared compiled module once and serves `hint`, `rate` and `solve` (uniqueness of a `#solve:`
puzzle). `line_status` runs on the main thread, on the instance from `loadSolver()`, because it is
needed after every stroke and costs well under a millisecond.

### Build, deploy, cache busting

- `web/build.sh` is unchanged. `web/pack.json` is committed; `make_pack.py` is run by hand.
- `pages.yml` copies the new files and rewrites `v=dev` in every text file it ships:

```yaml
      - run: web/build.sh
      - uses: actions/setup-node@v4
        with: {node-version: 22}
      - run: node --test web/test/*.test.mjs
      - run: |
          mkdir site
          cp -r web/index.html web/app.js web/hugi.js web/worker.js web/grid.js web/draw.js web/wasm.js web/hugi_web.wasm web/pack.json web/game site/
          find site -type f \( -name '*.html' -o -name '*.js' -o -name '*.css' \) -exec sed -i "s/v=dev/v=${GITHUB_SHA::10}/g" {} +
```

- Every relative URL in HTML, JS and CSS carries `?v=dev`: `game/main.js?v=dev`,
  `game/game.css?v=dev`, `fetch("pack.json?v=dev")`, `new Worker("game/worker.js?v=dev")`,
  `import … from "../hugi.js?v=dev"`.
- `ci.yml` adds `web/build.sh`, Node 22 and `node --test web/test/*.test.mjs` after the wasm build.

**Local tool chain on this machine** (nothing global on NixOS):
`nix shell nixpkgs#cargo nixpkgs#rustc nixpkgs#gcc nixpkgs#lld nixpkgs#clippy nixpkgs#rustfmt`
builds native and wasm (`lld` is needed for the wasm link; tested). The pack builder:
`nix shell --impure --expr '(builtins.getFlake "nixpkgs").legacyPackages.x86_64-linux.python3.withPackages (p: [p.pillow])' --command python3 scripts/make_pack.py`.
Serve with `python3 -m http.server -d web`.

## 7. Testing

**Without a browser** (all in CI):

- `cargo test`: `src/game.rs` tests
  - a 10-cell row with clue `8` and nothing known gives a line move of 6 cells, `open` 10;
  - a done-by-count line (`forced == open`) beats an overlap line in `next_move`;
  - `puzzles/hugi.txt` rates `probes: 1, max_steps: 4, tier: "brocade"` (21 wide);
    `puzzles/heart.txt` rates `moves: 38, probes: 0, tier: "twill"`; `puzzles/rings.txt` rates
    `search: true, tier: null` (the prototype measured these values);
  - a state with a filled cell in a `0` row gives `contradiction`;
  - `line_status` returns 2 for a row whose runs equal its clue, 1 for an impossible row;
  - replay property: for 200 random unique puzzles up to 15×15, applying `next_move` from empty
    reaches the solution when `search` is false.
- `cargo test -p hugi-web`: the JSON of each export parses for a fixture (as a string compare).
- `node --test web/test/*.test.mjs`:
  - `wasm.test.mjs`: the exports' JSON shapes; `hint` on fixtures;
  - `pack.test.mjs`: every puzzle decodes, sizes match, ids are unique, every `solve` with
    engine 0 says `unique: true`, every `rate` gives the stored tier and rating, and **hint
    replay**: applying `hint` from an empty state solves every pack and daily puzzle;
  - `grid.test.mjs`: `packBits` matches today's `app.js` output for the heart (golden string),
    and round-trips;
  - `rules.test.mjs`, `save.test.mjs` (a fake `localStorage`: migration, export and import round
    trip, corrupt input, the 10-entry progress cap), `pack.test.mjs` also covers `dailyFor`
    (fixed dates, the permutation covers all 60);
  - `board.test.mjs`: `strokePath` and `applyStroke`.

**In a browser** (manual, on desktop Chrome and Firefox and a phone at 360 px, each in day and
night):

1. An old share link `#15x15:…` opens the Maker with its picture; edits keep a `#WxH:` hash.
2. The empty URL opens Play; Play and Make switch back and forth and keep both states.
3. Fill, mark, drag with axis lock, undo, redo: by mouse, by touch, by keyboard only.
4. A drag over a marked cell leaves it; a done row greys its clue; an impossible row turns `--bad`.
5. Each hint and check, with and without a wrong cell on the board; each price charged once.
6. Win: the wave, the name, stars, skeins; with reduced motion, no wave.
7. Reload mid-puzzle: the board, timer and help flag come back.
8. Tier unlock at 20 solved; locked patches cannot take focus.
9. The daily card on two dates (change the clock): the streak counts, and resets after a gap.
10. Download, Start over, Load save: everything comes back.
11. Maker **Share…**: the solve link opens in Play with clues only; the edit link opens the Maker;
    a non-unique picture cannot get a solve link.
12. A 50×50 puzzle on the phone: Move scrolls, Fill draws.
13. A screen reader (Orca or VoiceOver) reads the cursor cell and the hint messages.
14. Storage blocked: the game plays and says that it cannot save.

## 8. Work packages

The shared contract is §2 (the wasm API and JSON) and §3 (the pack format), plus the interfaces in
§6. WP1 and WP2 come first and are small; then WP3 to WP6 run in parallel; then WP7a and WP7b.

| WP | files | needs | estimate |
|---|---|---|---|
| WP1 Solver API | `src/game.rs`, `src/lib.rs`, `src/main.rs`, `web/src/lib.rs`, `web/hugi.js`, `web/test/wasm.test.mjs` | – | 3 h |
| WP2 Shell | `web/grid.js`, `draw.js`, `wasm.js`, `index.html`, `app.js`, `game/main.js`, `game/game.css`, both workflows, `web/test/grid.test.mjs` | – | 2.5 h |
| WP3 Pack | `scripts/make_pack.py`, `scripts/pack/*`, `web/pack.json`, `web/test/pack.test.mjs`, README credits | WP1 (`hugi rate`, `hint`) for the rating step; curation starts at once | 4 h |
| WP4 Rules and save | `web/game/rules.js`, `save.js`, `pack.js`, their tests | WP2 (`grid.js`) | 2 h |
| WP5 Board | `web/game/board.js`, `web/test/board.test.mjs` | WP2 (`draw.js`, `grid.js`) | 3 h |
| WP6 Engine and hints | `web/game/worker.js`, `engine.js`, `hints.js`, `web/test/hints.test.mjs` | WP1 | 2 h |
| WP7a Quilt and dialogs | `web/game/quilt.js`, `quilt.css`, `dialogs.js` | WP2, WP4 | 3 h |
| WP7b Puzzle screen | `web/game/play.js`, `play.css` | WP2, WP4, WP5, WP6 | 4 h |
| WP9 Share to solve | `web/game/shared.js`, `web/test/shared.test.mjs`; the Share… dialog in `index.html` and `app.js`; the shelf in `quilt.js`; the several-solutions mode in `play.js` and `hints.js` | WP2, WP4, WP6; the shelf after WP7a, the play mode after WP7b | 3 h |
| WP8 Finish | README "Play" section, `docs/img/game.png`, the browser checklist of §7, fixes | all | 2 h |

Lanes: **A** WP1 ∥ WP2 ∥ WP3 (curation). **B** WP3 (rating) ∥ WP4 ∥ WP5 ∥ WP6 ∥ WP9 (`shared.js`,
the Maker dialog). **C** WP7a ∥ WP7b, then WP9 (shelf, play mode). **D** WP8. Critical path WP2 →
WP5 → WP7b → WP9 → WP8: about 13 h. WP9 edits files that WP2, WP7a and WP7b own, so it starts each
part after that owner has merged.

**Acceptance criteria** (each one is a command or an observable check):

- **WP1**: `cargo fmt --all --check`, `cargo clippy --workspace --all-targets -- -D warnings` and
  `cargo test --release` pass, with the `game.rs` tests of §7. `web/build.sh && node --test
  web/test/wasm.test.mjs` passes. `printf '..#..\n.###.\n#####\n' | ./target/release/hugi rate -`
  prints one JSON line with `"tier":"tabby"` and `"w":5,"h":3`. `hugi rate` input: pictures (rows
  of `#` and `.`) separated by blank lines, or one clue file; output one JSON line per puzzle:
  the rating plus `w` and `h`.
- **WP2**: `node --test web/test/grid.test.mjs` passes (golden heart packing). In a browser: the
  checks 1 and 2 of §7; `#play` stays in the address bar while the Maker is loaded (the Maker's
  `save()` writes the hash only when `body.dataset.view === "make"`; the drop and paste handlers
  act only then). `nix run nixpkgs#actionlint` passes on both workflows.
- **WP3**: `make_pack.py` runs twice with the same `sha256sum web/pack.json`. `node --test
  web/test/pack.test.mjs` passes (uniqueness, stored rating, hint replay, 150 + 60 puzzles, 30 per
  tier, no repeated icon). `make_pack.py --sheet` writes `target/pack-cache/sheet.png`, a contact
  sheet of all pictures with names, and a reviewer has looked at it. **First hour**: the sheet
  for 60 curated icons at 15, 20 and 30, for the lead to approve before the full run (risk 1).
- **WP4**: `node --test web/test/rules.test.mjs web/test/save.test.mjs` passes, including: 15×15
  par is 330 s; first solve of a Twill puzzle with 3 stars earns 6; a v1 save round-trips through
  export and import; a corrupt value gives a fresh save and is kept under `hugi-game-broken`.
- **WP5**: `node --test web/test/board.test.mjs` passes (the stroke rule cases of §1: start on
  empty, start on filled, a mark in the path, axis lock). `web/test/board.html` (a static page
  that loads one puzzle on the board) shows fill, mark, drag, undo, keyboard cursor and the reveal.
- **WP6**: `node --test web/test/hints.test.mjs` passes: a wrong cell is reported before any
  move; `runHint("cell")` on the heart from empty sets a cell that the solution agrees with;
  `track` and `mistakes` match `wrongCells`.
- **WP7a**: in a browser with a fixture save: tiers, locks, patches in all three states, the daily
  card, achievements dialog, download and load of the save.
- **WP7b**: in a browser: checks 3 to 8 of §7 on one Tabby and one Satin puzzle.
- **WP9**: `node --test web/test/shared.test.mjs` passes: `parseSolveLink(solveLink(x))` round-trips
  title and author with `&`, `#`, `å` and emoji; a 41-character title is cut to 40; `#15x15:…`,
  `#make` and garbage give `null`; `sharedId` is the same with and without a title. In a browser:
  the Share… dialog on a unique and a non-unique picture; a solve link opens with clues only and
  the title and author shown; a hand-made link to the Maker's Rings example (several solutions)
  opens with the note, wins on any clue-satisfying picture, and hides the checks; a solved shared
  puzzle is on the shelf with its stars and earned 0 skeins (5 once, for "A gift").
- **WP8**: the whole checklist of §7 done and noted in the PR; the README shows the game.

## Risks

1. **The pack does not look good, or the tiers are uneven.** Material Icons passed a 30-icon test
   (131 of 150 renders need no guess; clear shapes at 15 and 20). The risk left is curation:
   UI-like icons and a thin Tapestry tier with probes. Retire it in WP3's first hour with the
   contact sheet of 60 icons and their tiers, approved before the full run. If Tapestry lacks
   probe puzzles, fill it with 40×40 and 50×50 line puzzles; difficulty there comes from size.
2. **Hints feel random or wrong.** The ranking of §2 is a heuristic about humans. Retire it with
   the replay test (every pack puzzle solves by hints alone, in CI) and by playing three puzzles
   per tier with hints only in WP8. The ranking is one tested function in `game.rs`.
3. **Touch play on large boards.** Cells of 13 to 14 px and a Move tool are a compromise. Retire it
   in WP5 with `board.html` on a real phone at 25×25 and 40×40 before WP7b builds on it. The
   fallback is to mark Tapestry "desktop" and keep the phone to 25×25.

## Not now

- Colour nonograms, timed modes, lives, a strict mode that rejects wrong moves; sound.
- Accounts, cloud sync, leaderboards; offline install (service worker); translations.
- Explaining a line move by drawing the clue's placements: the best teaching tool, and it needs its
  own design.
- The tier of a drawn picture in the Maker (a small follow-up on the `rate` export); a list of
  solved shared puzzles; pinch zoom and sticky clue headers on phones; a campaign above 50×50.
