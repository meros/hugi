import test from "node:test";
import assert from "node:assert/strict";
import { solveLink, parseSolveLink, sharedId, sharedPuzzle, threadOf } from "../game/shared.js";
import { packBits, cluesOf } from "../grid.js";

const w = 5;
const h = 5;
const cells = Uint8Array.from("01110 10001 10001 01110 00100".replace(/ /g, ""), Number);
const bits = packBits(w, h, cells);

test("a solve link round trips title and author with &, #, å and emoji", () => {
  const title = "Rock & roll #1 på 🎸";
  const author = "Åsa=ö&t=x";
  const back = parseSolveLink(solveLink({ w, h, cells, title, author }));
  assert.equal(back.title, title);
  assert.equal(back.author, author);
  assert.equal(back.w, 5);
  assert.equal(back.bits, bits);
  assert.deepEqual([...back.cells], [...cells]);
});

test("no title and no author give a bare link", () => {
  assert.equal(solveLink({ w, h, cells }), `#solve:5x5:${bits}`);
  const p = parseSolveLink(`#solve:5x5:${bits}`);
  assert.equal(p.title, "");
  assert.equal(p.author, "");
});

test("a title of 41 characters is cut to 40, never in the middle of an emoji", () => {
  const p = parseSolveLink(solveLink({ w, h, cells, title: "x".repeat(41) }));
  assert.equal(p.title.length, 40);
  const long = parseSolveLink(`#solve:5x5:${bits}&t=${encodeURIComponent("a".repeat(39) + "🎸🎸")}`);
  assert.equal(long.title, "a".repeat(39));
  const huge = parseSolveLink(`#solve:5x5:${bits}&a=${"y".repeat(5000)}`);
  assert.equal(huge.author.length, 40);
});

test("unknown keys are ignored and hostile text stays text", () => {
  const p = parseSolveLink(`#solve:5x5:${bits}&v=2&t=${encodeURIComponent("<img src=x onerror=alert(1)>")}&zz`);
  assert.equal(p.title, "<img src=x onerror=alert(1)>");
});

test("edit links, #make and garbage give null and never throw", () => {
  const bad = [
    `#5x5:${bits}`,
    "#make",
    "",
    "#solve:",
    "#solve:abc",
    "#solve:5x5:",
    "#solve:5x5:AAAA", // too short
    `#solve:5x5:${bits}A`, // too long
    "#solve:5x5:@@@@@@",
    "#solve:0x5:AAAAAA",
    "#solve:101x1:" + "A".repeat(18),
    "#solve:-5x5:AAAAAA",
    `#solve:5x5:${bits}&t=%E0%A4%A`, // broken percent escape
    null,
    undefined,
    42,
    {},
  ];
  for (const b of bad) assert.equal(parseSolveLink(b), null, String(b));
});

test("sizes up to 100x100 parse", () => {
  const big = new Uint8Array(100 * 100).map((_, i) => (i % 3 === 0 ? 1 : 0));
  const p = parseSolveLink(solveLink({ w: 100, h: 100, cells: big }));
  assert.equal(p.w, 100);
  assert.deepEqual([...p.cells], [...big]);
  assert.equal(parseSolveLink(solveLink({ w: 1, h: 1, cells: [1] })).cells[0], 1);
});

test("sharedId is the same with and without a title, and differs for another picture", () => {
  const a = parseSolveLink(solveLink({ w, h, cells, title: "A", author: "B" }));
  const b = parseSolveLink(solveLink({ w, h, cells }));
  assert.equal(sharedId(a.w, a.h, a.bits), sharedId(b.w, b.h, b.bits));
  assert.match(sharedId(5, 5, bits), /^s-[0-9a-f]{8}$/);
  assert.notEqual(sharedId(5, 5, bits), sharedId(5, 5, packBits(5, 5, new Uint8Array(25))));
  assert.equal(sharedId(5, 5, "AAAAAA"), "s-bcba5a6d"); // FNV-1a 32 of "5x5:AAAAAA", checked with Python
});

test("sharedPuzzle builds a Puzzle of kind shared", () => {
  const p = sharedPuzzle(solveLink({ w, h, cells, title: "Plus", author: "Ann" }), { unique: true, rating: { probes: 0 } });
  assert.equal(p.kind, "shared");
  assert.equal(p.name, "Plus");
  assert.equal(p.author, "Ann");
  assert.equal(p.unique, true);
  assert.deepEqual(p.rating, { probes: 0 });
  assert.deepEqual(p.rows, cluesOf(w, h, cells).rows);
  assert.equal(p.id, sharedId(w, h, bits));
  assert.ok(p.thread >= 1 && p.thread <= 5 && p.thread === threadOf(p.id));
  const bare = sharedPuzzle(`#solve:5x5:${bits}`);
  assert.equal(bare.name, "Shared picture");
  assert.equal("unique" in bare, false);
  assert.equal("rating" in bare, false);
  assert.equal(sharedPuzzle("#nope"), null);
});
