// Clues and packing, shared by the Maker (app.js) and the game (game/*.js). Pure: no DOM.

// The runs of filled cells in one line, for example [1, 1, 0, 1, 1, 1] gives [2, 3].
export function runs(cells) {
  const out = [];
  let n = 0;
  for (const c of [...cells, 0]) {
    if (c) n++;
    else if (n) {
      out.push(n);
      n = 0;
    }
  }
  return out;
}

// The clues of a picture: cells is w*h values, nonzero = filled, row-major.
export function cluesOf(w, h, cells) {
  const rows = [];
  const cols = [];
  for (let y = 0; y < h; y++) rows.push(runs(Array.from(cells.subarray ? cells.subarray(y * w, y * w + w) : cells.slice(y * w, y * w + w))));
  for (let x = 0; x < w; x++) cols.push(runs(Array.from({ length: h }, (_, y) => cells[y * w + x])));
  return { rows, cols };
}

// Hugi's plain puzzle format; an empty line is written 0.
export function cluesText({ rows, cols }) {
  const line = (c) => (c.length ? c.join(" ") : "0");
  return `rows\n${rows.map(line).join("\n")}\ncols\n${cols.map(line).join("\n")}\n`;
}

// The board state for the solver: "state", then h lines of w characters: # filled, . marked, ? unknown.
export function stateText(w, h, state) {
  const ch = ["?", "#", "."];
  const lines = [];
  for (let y = 0; y < h; y++) {
    let s = "";
    for (let x = 0; x < w; x++) s += ch[state[y * w + x]] ?? "?";
    lines.push(s);
  }
  return "state\n" + lines.join("\n");
}

// The share-link packing: cell i is bit (i & 7) of byte (i >> 3), base64url without padding.
export function packBits(w, h, cells) {
  const bytes = new Uint8Array(Math.ceil((w * h) / 8));
  for (let i = 0; i < w * h; i++) if (cells[i]) bytes[i >> 3] |= 1 << (i & 7);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// The inverse of packBits. Throws on text that is not base64url.
export function unpackBits(w, h, s) {
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/"));
  const out = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) out[i] = (bin.charCodeAt(i >> 3) >> (i & 7)) & 1;
  return out;
}
