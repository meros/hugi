// Puzzles shared from the Maker (docs/game-design.md 5b): the #solve: link, its parser and the shared id.
// Pure: no DOM, no storage. The parser never throws; anything that is not a good link gives null.

import { packBits, unpackBits, cluesOf } from "../grid.js?v=dev";

export const MAX_SIDE = 100; // as in the Maker
export const MAX_TEXT = 40; // characters of a title or an author name
const PREFIX = "#solve:";

// At most MAX_TEXT UTF-16 units (the save checks .length), never half of a surrogate pair.
function cut(s) {
  let out = s.replace(/[\u0000-\u001f\u007f]+/g, " ").trim();
  if (out.length > MAX_TEXT) {
    out = out.slice(0, MAX_TEXT);
    if (/[\ud800-\udbff]$/.test(out)) out = out.slice(0, -1);
    out = out.trimEnd();
  }
  return out;
}

/** "#solve:WxH:bits&t=<title>&a=<author>" for a picture. title and author are optional. */
export function solveLink({ w, h, cells, title = "", author = "" }) {
  const t = cut(String(title ?? ""));
  const a = cut(String(author ?? ""));
  return `${PREFIX}${w}x${h}:${packBits(w, h, cells)}${t ? `&t=${encodeURIComponent(t)}` : ""}${a ? `&a=${encodeURIComponent(a)}` : ""}`;
}

// The characters of a base64url string that hold w*h bits, without padding.
const bitsLength = (w, h) => Math.ceil((Math.ceil((w * h) / 8) * 4) / 3);

/** The parts of a solve link, or null for anything else (an edit link, #make, garbage, a cut-off link). */
export function parseSolveLink(hash) {
  try {
    if (typeof hash !== "string") return null;
    const m = /^#solve:(\d{1,3})x(\d{1,3}):([A-Za-z0-9_-]*)((?:&.*)?)$/s.exec(hash);
    if (!m) return null;
    const w = +m[1];
    const h = +m[2];
    const bits = m[3];
    if (w < 1 || h < 1 || w > MAX_SIDE || h > MAX_SIDE || bits.length !== bitsLength(w, h)) return null;
    let title = "";
    let author = "";
    for (const part of m[4].split("&").slice(1)) {
      const at = part.indexOf("=");
      if (at < 0) continue;
      const key = part.slice(0, at);
      if (key !== "t" && key !== "a") continue; // unknown keys are ignored
      const value = cut(decodeURIComponent(part.slice(at + 1)));
      if (key === "t") title = value;
      else author = value;
    }
    return { w, h, bits, cells: unpackBits(w, h, bits), title, author };
  } catch {
    return null;
  }
}

/** The id of a shared picture: "s-" and the FNV-1a hash of "WxH:bits" in 8 hex digits. Title and author do not count. */
export function sharedId(w, h, bits) {
  let x = 0x811c9dc5;
  for (const ch of `${w}x${h}:${bits}`) {
    x = Math.imul(x ^ ch.charCodeAt(0), 0x01000193) >>> 0;
  }
  return "s-" + x.toString(16).padStart(8, "0");
}

/** A shared picture has no thread of its own: its id picks a steady one (1 to 5). */
export const threadOf = (id) => 1 + (id.charCodeAt(id.length - 1) % 5);

/**
 * A Puzzle (see pack.js) for a solve link, or null when the link is bad. link is the hash or the parsed link.
 * unique and rating are set only when the caller already knows them; play.js checks the rest on arrival.
 */
export function sharedPuzzle(link, { unique, rating } = {}) {
  const p = typeof link === "string" ? parseSolveLink(link) : link;
  if (!p?.cells) return null;
  const id = sharedId(p.w, p.h, p.bits);
  const out = {
    id,
    name: p.title || "Shared picture",
    title: p.title || "",
    author: p.author || "",
    w: p.w,
    h: p.h,
    bits: p.bits,
    solution: p.cells,
    ...cluesOf(p.w, p.h, p.cells),
    thread: threadOf(id),
    tier: null,
    kind: "shared",
  };
  if (unique !== undefined) out.unique = unique;
  if (rating !== undefined) out.rating = rating;
  return out;
}
