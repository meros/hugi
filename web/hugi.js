// A thin wrapper around the WebAssembly exports (see web/src/lib.rs).
// Used by the page (to read clues) and by the workers (to solve).

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export async function instantiate(module) {
  const { exports: x } = await WebAssembly.instantiate(module, {});
  function call(name, text, ...extra) {
    const bytes = encoder.encode(text);
    const ptr = x.alloc(bytes.length);
    new Uint8Array(x.memory.buffer, ptr, bytes.length).set(bytes);
    try {
      const n = x[name](ptr, bytes.length, ...extra);
      const out = decoder.decode(new Uint8Array(x.memory.buffer, x.result_ptr(), n));
      return JSON.parse(out);
    } finally {
      x.dealloc(ptr, bytes.length);
    }
  }
  return {
    // The clues of a puzzle in any format Hugi reads: {rows, cols} or {error}.
    clues: (text) => call("clues", text),
    // Solve with one engine: 0 probing search, 1 learning solver with cells only,
    // 2 learning solver with block-position variables, 4 a perturbed copy of 2.
    solve: (text, engine) => call("solve", text, engine),
    // One step of "make unique" on a picture (rows of # and .): see make_unique_step in web/src/lib.rs.
    uniqueStep: (picture, engine) => call("make_unique_step", picture, engine),
    // The easiest next move for a board: the clues, a line "state", then one line per row of
    // # filled, . marked, ? unknown. A Move: {kind: "line" | "probe" | "contradiction" | "none" | "solved", ...}.
    hint: (text) => call("hint", text),
    // The status of every clue of a board (same text as hint): {rows, cols}, 0 open, 1 impossible, 2 done.
    lineStatus: (text) => call("line_status", text),
    // The rating of a puzzle: {moves, probes, max_steps, sum_steps, search, effort, tier}.
    rate: (text) => call("rate", text),
  };
}
