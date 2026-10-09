// Hugi in the browser: draw a picture, see its clues, and learn at once whether the
// puzzle has one solution. The solver is the Rust code from this repository, compiled to
// WebAssembly; each edit starts three engines in Web Workers and the first answer wins.

import { instantiate } from "./hugi.js?v=dev";

const $ = (id) => document.getElementById(id);
const css = (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim();

const MAX = 100;
let W = 15;
let H = 15;
let pic = new Uint8Array(W * H); // 1 = filled
let hugi = null; // WebAssembly instance on the main thread (reads clues)
let module = null; // compiled module, shared with the workers
let result = null; // the last solver result
let diff = null; // cells where the two solutions differ
let jobId = 0;
let workers = [];
let ticker = null;
let geom = { left: 0, top: 0, cell: 10 };
let fromClues = false; // the current job reads a pasted puzzle, not the picture
let thread = 1; // the colour of the tiles (--t1 .. --t5)
let fixed = new Set(); // cells changed by "Make unique"
let lastFix = null; // {undo, count} after a Make unique run

// ── Examples ────────────────────────────────────────────────────────────────

const PICTURES = {
  heart: `
...............
..###.....###..
.#####...#####.
#######.#######
###############
###############
###############
.#############.
..###########..
...#########...
....#######....
.....#####.....
......###......
.......#.......
...............`,
  smiley: `
..######..
.########.
##########
##..##..##
##..##..##
##########
#.######.#
##......##
.########.
..######..`,
  house: `
.......#.......
......###......
.....#####.....
....#######....
...#########...
..###########..
.#############.
###############
.#############.
.##..#####..##.
.##..#####..##.
.#############.
.#####...#####.
.#####...#####.
.#####...#####.`,
  hugi: `
#...#.#...#..####.###
#...#.#...#.#......#.
#...#.#...#.#......#.
#####.#...#.#..##..#.
#...#.#...#.#...#..#.
#...#.#...#.#...#..#.
#...#..###...####.###`,
};

function computed(n, f) {
  return Array.from({ length: n }, (_, y) => Array.from({ length: n }, (_, x) => (f(x, y, n) ? "#" : ".")).join("")).join("\n");
}
PICTURES.rings = computed(31, (x, y, n) => Math.floor(Math.hypot(x - (n - 1) / 2, y - (n - 1) / 2)) % 4 < 2);
PICTURES.sierpinski = computed(32, (x, y) => (x & y) === 0);

function resetFix() {
  fixed = new Set();
  lastFix = null;
}

function loadPicture(text) {
  resetFix();
  const lines = text.trim().split("\n");
  W = lines[0].length;
  H = lines.length;
  pic = new Uint8Array(W * H);
  lines.forEach((l, y) => [...l].forEach((ch, x) => (pic[y * W + x] = ch === "#" ? 1 : 0)));
  syncInputs();
  changed();
}

// ── Clues ───────────────────────────────────────────────────────────────────

function runs(cells) {
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

function clues() {
  const rows = [];
  const cols = [];
  for (let y = 0; y < H; y++) rows.push(runs(pic.subarray(y * W, y * W + W)));
  for (let x = 0; x < W; x++) cols.push(runs(Array.from({ length: H }, (_, y) => pic[y * W + x])));
  return { rows, cols };
}

function puzzleText() {
  const { rows, cols } = clues();
  const line = (c) => (c.length ? c.join(" ") : "0");
  return `rows\n${rows.map(line).join("\n")}\ncols\n${cols.map(line).join("\n")}\n`;
}

// ── Drawing ─────────────────────────────────────────────────────────────────

const canvas = $("board");
const ctx = canvas.getContext("2d");

function draw() {
  const { rows, cols } = clues();
  const show = (c) => (c.length ? c : [0]);
  const rmax = Math.max(...rows.map((r) => show(r).length));
  const cmax = Math.max(...cols.map((c) => show(c).length));
  const avail = Math.max(220, $("board-wrap").clientWidth - 28);
  const cell = Math.max(6, Math.min(30, Math.floor(avail / (W + rmax * 0.9))));
  const left = Math.ceil(rmax * cell * 0.9) + 4;
  const top = Math.ceil(cmax * cell * 0.9) + 4;
  geom = { left, top, cell };
  const dpr = window.devicePixelRatio || 1;
  const cw = left + W * cell + 2;
  const ch = top + H * cell + 2;
  canvas.width = cw * dpr;
  canvas.height = ch * dpr;
  canvas.style.width = cw + "px";
  canvas.style.height = ch + "px";
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, cw, ch); // the linen of the page shows through
  const color = css("--t" + thread);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      if (pic[y * W + x]) tile(left + x * cell, top + y * cell, cell, color);
      if (fixed.has(y * W + x)) {
        ctx.strokeStyle = css("--good");
        ctx.lineWidth = 2;
        ctx.setLineDash([3, 2]);
        ctx.strokeRect(left + x * cell + 1.5, top + y * cell + 1.5, cell - 3, cell - 3);
        ctx.setLineDash([]);
      }
      if (diff && diff[y * W + x]) {
        ctx.fillStyle = css("--madder-fill");
        ctx.fillRect(left + x * cell, top + y * cell, cell, cell);
        ctx.strokeStyle = css("--madder");
        ctx.lineWidth = 2;
        ctx.setLineDash([3, 2]);
        ctx.strokeRect(left + x * cell + 1.5, top + y * cell + 1.5, cell - 3, cell - 3);
        ctx.setLineDash([]);
      }
    }
  }
  const line = (x1, y1, x2, y2, bold) => {
    ctx.strokeStyle = bold ? css("--heavy") : css("--line");
    ctx.lineWidth = bold ? 1.2 : 0.6;
    ctx.beginPath();
    ctx.moveTo(x1 + 0.5, y1 + 0.5);
    ctx.lineTo(x2 + 0.5, y2 + 0.5);
    ctx.stroke();
  };
  for (let i = 0; i <= W; i++) line(left + i * cell, top, left + i * cell, top + H * cell, i % 5 === 0);
  for (let i = 0; i <= H; i++) line(left, top + i * cell, left + W * cell, top + i * cell, i % 5 === 0);
  if (cell >= 9) {
    ctx.fillStyle = css("--ink");
    ctx.font = `${Math.floor(cell * 0.66)}px ${css("--serif")}`;
    ctx.textBaseline = "middle";
    ctx.textAlign = "right";
    rows.forEach((r, i) => [...show(r)].reverse().forEach((v, k) => ctx.fillText(v, left - 4 - k * cell * 0.9, top + (i + 0.5) * cell)));
    ctx.textAlign = "center";
    cols.forEach((c, i) => [...show(c)].reverse().forEach((v, k) => ctx.fillText(v, left + (i + 0.5) * cell, top - cell * 0.5 - k * cell * 0.9)));
  }
}

// A tile: an almost full square with softly rounded corners, so that neighbouring tiles read as one picture.
function tile(px, py, cell, color) {
  const m = cell < 9 ? 0 : Math.max(0.5, cell * 0.035);
  const size = cell - 2 * m;
  ctx.fillStyle = color;
  ctx.beginPath();
  if (ctx.roundRect && cell >= 9) ctx.roundRect(px + m, py + m, size, size, cell * 0.12);
  else ctx.rect(px + m, py + m, size, size);
  ctx.fill();
}

// ── Painting ────────────────────────────────────────────────────────────────

let painting = null; // the value being painted (1 or 0), or null

function cellAt(e) {
  const r = canvas.getBoundingClientRect();
  const x = Math.floor((e.clientX - r.left - geom.left) / geom.cell);
  const y = Math.floor((e.clientY - r.top - geom.top) / geom.cell);
  return x >= 0 && y >= 0 && x < W && y < H ? y * W + x : -1;
}

function paint(e) {
  const i = cellAt(e);
  if (i < 0 || painting === null || pic[i] === painting) return;
  pic[i] = painting;
  fromClues = false;
  result = null;
  diff = null;
  fixed = new Set();
  lastFix = null;
  draw();
}

canvas.addEventListener("pointerdown", (e) => {
  const i = cellAt(e);
  if (i < 0) return;
  e.preventDefault();
  canvas.setPointerCapture(e.pointerId);
  painting = e.button === 2 || e.shiftKey ? 0 : pic[i] ? 0 : 1;
  paint(e);
});
canvas.addEventListener("pointermove", (e) => painting !== null && paint(e));
const stop = () => {
  if (painting !== null) {
    painting = null;
    changed();
  }
};
canvas.addEventListener("pointerup", stop);
canvas.addEventListener("pointercancel", stop);
canvas.addEventListener("contextmenu", (e) => e.preventDefault());

// ── Solving ─────────────────────────────────────────────────────────────────

const ENGINES = [2, 0, 1]; // block-position learning solver, probing search, cells-only learning solver
const WHY = {
  "line logic": "Every row and column was solved exactly until nothing more followed. No search was needed.",
  "probing search": "The probing search won: before each branch it tries both values of every open cell and keeps what is forced.",
  "learning solver": "A learning solver won: line logic inside a SAT-style search that turns each contradiction into a learned rule.",
};

let debounce = null;
function changed() {
  save();
  draw();
  clearTimeout(debounce);
  if (fromClues) return;
  debounce = setTimeout(solve, 180);
}

function stopWorkers() {
  workers.forEach((w) => w.terminate());
  workers = [];
  clearInterval(ticker);
}

function setStatus(kind, title, body = "") {
  const v = $("verdict");
  v.className = "verdict " + kind;
  v.textContent = title;
  $("detail").innerHTML = body;
}

function solve(text = null) {
  stopWorkers();
  const id = ++jobId;
  const input = typeof text === "string" ? text : puzzleText();
  if (!pic.some(Boolean) && typeof text !== "string") {
    result = null;
    diff = null;
    setStatus("idle", "Draw something", "Click and drag on the grid. Right-click or shift-drag erases.");
    draw();
    return;
  }
  const t0 = performance.now();
  setStatus("busy", "Solving…", "");
  ticker = setInterval(() => {
    $("verdict").textContent = `Solving… ${((performance.now() - t0) / 1000).toFixed(1)} s`;
  }, 100);
  let failed = 0;
  for (const engine of ENGINES) {
    const w = new Worker("worker.js?v=dev", { type: "module" });
    workers.push(w);
    w.onmessage = ({ data }) => {
      if (id !== jobId) return;
      if (data.error || data.result.error) {
        if (++failed === ENGINES.length) {
          stopWorkers();
          setStatus("bad", "Could not solve", String(data.error || data.result.error));
        }
        return;
      }
      stopWorkers();
      show(data.result, (performance.now() - t0) / 1000);
    };
    w.onerror = (e) => {
      if (id === jobId && ++failed === ENGINES.length) {
        stopWorkers();
        setStatus("bad", "Could not solve", e.message || "the worker failed");
      }
    };
    w.postMessage({ module, text: input, engine, id });
  }
}

function fmt(t) {
  return t < 0.001 ? "under 1 ms" : t < 1 ? `${(t * 1000).toFixed(0)} ms` : `${t.toFixed(2)} s`;
}

function show(r, seconds) {
  result = r;
  diff = null;
  const sols = r.solutions || [];
  const cell = (s, i) => s[Math.floor(i / r.width)][i % r.width] === "#";
  if (fromClues && sols.length) {
    W = r.width;
    H = r.height;
    pic = new Uint8Array(W * H);
    for (let i = 0; i < W * H; i++) pic[i] = cell(sols[0], i) ? 1 : 0;
    syncInputs();
  }
  let verdict;
  let kind;
  if (sols.length === 0) {
    verdict = "No solution";
    kind = "bad";
  } else if (sols.length === 1) {
    verdict = "Unique solution";
    kind = "good";
  } else {
    verdict = "More than one solution";
    kind = "warn";
    diff = new Uint8Array(W * H);
    let n = 0;
    for (let i = 0; i < W * H; i++) if (cell(sols[0], i) !== cell(sols[1], i)) (diff[i] = 1), n++;
    verdict += ` (${n} cells differ)`;
  }
  const noGuess = r.engine === "line logic";
  const why = WHY[r.engine] || (r.engine.startsWith("learning solver") ? WHY["learning solver"] : "");
  const pct = ((100 * r.root_known) / r.cells).toFixed(0);
  let body = `<dl>
    <dt>time</dt><dd>${fmt(seconds)}</dd>
    <dt>difficulty</dt><dd>${noGuess ? "no guessing needed" : "needs guessing"}</dd>
    <dt>line logic alone</dt><dd>${pct} % of cells</dd>
    <dt>won by</dt><dd>${r.engine}</dd>
    ${r.nodes ? `<dt>search nodes</dt><dd>${r.nodes.toLocaleString()}</dd>` : ""}
    ${r.conflicts ? `<dt>learned rules</dt><dd>${r.conflicts.toLocaleString()}</dd>` : ""}
  </dl><p class="note">${why}</p>`;
  if (diff) {
    body += `<p class="note">The red cells are where two valid solutions disagree. Change one of them and the puzzle may become unique.</p>
      <p><button id="make-unique">Make unique</button></p>
      <p class="note">Or look at them: <button id="use1">solution 1</button> <button id="use2">solution 2</button></p>`;
  }
  setStatus(kind, verdict, body);
  if (kind === "good" && lastFix) {
    $("detail").insertAdjacentHTML(
      "beforeend",
      `<p class="note">Changed ${lastFix.count} cell${lastFix.count === 1 ? "" : "s"} (outlined in green) to make it unique. <button id="undo-fix">Undo</button></p>`,
    );
    $("undo-fix").onclick = () => {
      const u = lastFix;
      lastFix = null;
      fixed = new Set();
      usePicture(u.w, u.h, u.undo);
    };
  }
  if (diff) {
    $("make-unique").onclick = makeUnique;
    [1, 2].forEach((k) => {
      $("use" + k).onclick = () => {
        for (let i = 0; i < W * H; i++) pic[i] = cell(sols[k - 1], i) ? 1 : 0;
        changed();
      };
    });
  }
  if (fromClues) save();
  fromClues = false;
  draw();
}

// ── Controls ────────────────────────────────────────────────────────────────

function syncInputs() {
  $("w").value = W;
  $("h").value = H;
}

function resize() {
  const nw = Math.max(1, Math.min(MAX, parseInt($("w").value) || W));
  const nh = Math.max(1, Math.min(MAX, parseInt($("h").value) || H));
  resetFix();
  const next = new Uint8Array(nw * nh);
  for (let y = 0; y < Math.min(H, nh); y++) for (let x = 0; x < Math.min(W, nw); x++) next[y * nw + x] = pic[y * W + x];
  W = nw;
  H = nh;
  pic = next;
  syncInputs();
  fromClues = false;
  changed();
}
$("w").addEventListener("change", resize);
$("h").addEventListener("change", resize);

$("clear").onclick = () => {
  resetFix();
  pic.fill(0);
  fromClues = false;
  changed();
};
$("random").onclick = () => {
  resetFix();
  for (let i = 0; i < pic.length; i++) pic[i] = Math.random() < 0.5 ? 1 : 0;
  fromClues = false;
  changed();
};
$("examples").addEventListener("change", (e) => {
  if (PICTURES[e.target.value]) loadPicture(PICTURES[e.target.value]);
  e.target.value = "";
});

// ── Import ──────────────────────────────────────────────────────────────────
// Clues (Hugi, webpbn .nin, .non), a picture drawn with # and ., or an image.

const dialog = $("import-dialog");
let image = null; // the chosen image, when there is one

function openImport(file = null) {
  $("import-error").textContent = "";
  if (!dialog.open) dialog.showModal();
  if (file) chooseFile(file);
}
function resetImport() {
  image = null;
  $("image-opts").hidden = true;
  $("import-text").hidden = false;
  $("import-file").value = "";
}
$("import").onclick = () => {
  resetImport();
  openImport();
};
$("import-cancel").onclick = () => dialog.close();
$("import-file").onchange = (e) => e.target.files[0] && chooseFile(e.target.files[0]);

async function chooseFile(file) {
  $("import-error").textContent = "";
  if (file.type.startsWith("image/") || /\.(png|jpe?g|gif|webp|bmp)$/i.test(file.name)) {
    try {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.src = url;
      await img.decode();
      URL.revokeObjectURL(url);
      image = img;
      $("import-text").value = "";
      $("import-text").hidden = true;
      $("image-opts").hidden = false;
      const aspect = img.naturalHeight / img.naturalWidth;
      $("img-w").value = Math.max(5, Math.min(100, Math.round(aspect > 1 ? 40 / aspect : 40)));
      previewImage();
    } catch {
      $("import-error").textContent = "Could not read that image.";
    }
  } else {
    image = null;
    $("image-opts").hidden = true;
    $("import-text").hidden = false;
    $("import-text").value = await file.text();
  }
}

// Otsu's method: the threshold that best separates dark from light.
function otsu(gray) {
  const hist = new Array(256).fill(0);
  gray.forEach((g) => hist[Math.round(g)]++);
  const total = gray.length;
  let sum = 0;
  hist.forEach((n, v) => (sum += n * v));
  let wb = 0;
  let sb = 0;
  let best = 128;
  let bestVar = -1;
  for (let t = 0; t < 256; t++) {
    wb += hist[t];
    if (!wb) continue;
    const wf = total - wb;
    if (!wf) break;
    sb += t * hist[t];
    const mb = sb / wb;
    const mf = (sum - sb) / wf;
    const v = wb * wf * (mb - mf) ** 2;
    if (v > bestVar) {
      bestVar = v;
      best = t;
    }
  }
  return best;
}

// The image as a picture: shrunk in steps (a straight shrink to a few cells aliases), turned to grey,
// then thresholded, optionally with error diffusion. Dark pixels become filled cells.
function imageToPicture(img, w, { threshold, auto, dither, invert }) {
  const h = Math.max(1, Math.min(100, Math.round((w * img.naturalHeight) / img.naturalWidth)));
  let src = img;
  let sw = img.naturalWidth;
  let sh = img.naturalHeight;
  while (sw > 2 * w) {
    const nw = Math.max(w, Math.floor(sw / 2));
    const nh = Math.max(h, Math.floor(sh / 2));
    const c = document.createElement("canvas");
    c.width = nw;
    c.height = nh;
    const g = c.getContext("2d");
    g.fillStyle = "#fff";
    g.fillRect(0, 0, nw, nh);
    g.imageSmoothingQuality = "high";
    g.drawImage(src, 0, 0, nw, nh);
    src = c;
    sw = nw;
    sh = nh;
  }
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  const g = c.getContext("2d", { willReadFrequently: true });
  g.fillStyle = "#fff";
  g.fillRect(0, 0, w, h);
  g.imageSmoothingQuality = "high";
  g.drawImage(src, 0, 0, w, h);
  const px = g.getImageData(0, 0, w, h).data;
  const gray = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) {
    const a = px[4 * i + 3] / 255;
    const lum = 0.299 * px[4 * i] + 0.587 * px[4 * i + 1] + 0.114 * px[4 * i + 2];
    gray[i] = lum * a + 255 * (1 - a);
  }
  const t = auto ? otsu(gray) : threshold;
  const out = new Uint8Array(w * h);
  if (dither) {
    const err = Float32Array.from(gray);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        const v = err[i];
        const white = v > t;
        const e = v - (white ? 255 : 0);
        out[i] = white ? 0 : 1;
        if (x + 1 < w) err[i + 1] += (e * 7) / 16;
        if (y + 1 < h) {
          if (x > 0) err[i + w - 1] += (e * 3) / 16;
          err[i + w] += (e * 5) / 16;
          if (x + 1 < w) err[i + w + 1] += e / 16;
        }
      }
    }
  } else {
    for (let i = 0; i < w * h; i++) out[i] = gray[i] <= t ? 1 : 0;
  }
  if (invert) for (let i = 0; i < out.length; i++) out[i] ^= 1;
  return { w, h, cells: out, threshold: t };
}

function imageOptions() {
  return {
    threshold: +$("img-t").value,
    auto: $("img-auto").checked,
    dither: $("img-dither").checked,
    invert: $("img-invert").checked,
  };
}

function previewImage() {
  if (!image) return;
  const w = +$("img-w").value;
  const r = imageToPicture(image, w, imageOptions());
  $("img-w-out").textContent = w;
  if ($("img-auto").checked) $("img-t").value = r.threshold;
  $("img-t").disabled = $("img-auto").checked;
  $("img-t-out").textContent = Math.round(r.threshold);
  const k = Math.max(2, Math.min(8, Math.floor(420 / Math.max(r.w, r.h))));
  const cv = $("img-preview");
  cv.width = r.w * k;
  cv.height = r.h * k;
  const g = cv.getContext("2d");
  g.fillStyle = "#fff";
  g.fillRect(0, 0, cv.width, cv.height);
  g.fillStyle = "#222";
  for (let y = 0; y < r.h; y++) for (let x = 0; x < r.w; x++) if (r.cells[y * r.w + x]) g.fillRect(x * k, y * k, k, k);
  $("img-size").textContent = `${r.w} × ${r.h} cells, ${r.cells.reduce((a, b) => a + b, 0)} filled`;
}
["img-w", "img-t", "img-auto", "img-dither", "img-invert"].forEach((id) => $(id).addEventListener("input", previewImage));

function usePicture(w, h, cells) {
  resetFix();
  W = w;
  H = h;
  pic = Uint8Array.from(cells);
  fromClues = false;
  syncInputs();
  changed();
}

// Text that is a picture: rows of # (filled) and . (empty), also X and _ .
function textPicture(text) {
  const lines = text.split(/\r?\n/).map((l) => l.replace(/\s+$/, "")).filter((l) => l.length);
  if (lines.length < 2 || !lines.every((l) => /^[#.Xx_*@ -]+$/.test(l)) || !lines.some((l) => /[#Xx*@]/.test(l))) return null;
  const w = Math.max(...lines.map((l) => l.length));
  if (w > MAX || lines.length > MAX) return { error: `A picture can be at most ${MAX} × ${MAX} cells.` };
  const cells = new Uint8Array(w * lines.length);
  lines.forEach((l, y) => [...l].forEach((ch, x) => (cells[y * w + x] = /[#Xx*@]/.test(ch) ? 1 : 0)));
  return { w, h: lines.length, cells };
}

$("import-go").onclick = () => {
  const err = (m) => ($("import-error").textContent = m);
  if (image) {
    const r = imageToPicture(image, +$("img-w").value, imageOptions());
    dialog.close();
    usePicture(r.w, r.h, r.cells);
    return;
  }
  const text = $("import-text").value;
  if (!text.trim()) return err("Choose a file or paste something first.");
  const picture = textPicture(text);
  if (picture) {
    if (picture.error) return err(picture.error);
    dialog.close();
    usePicture(picture.w, picture.h, picture.cells);
    return;
  }
  const c = hugi.clues(text);
  if (c.error) return err(`That is not a puzzle I can read (${c.error}). The formats are listed above.`);
  dialog.close();
  W = c.cols.length;
  H = c.rows.length;
  pic = new Uint8Array(W * H);
  syncInputs();
  fromClues = true;
  result = null;
  diff = null;
  fixed = new Set();
  lastFix = null;
  draw();
  solve(text);
};

// Drop a file anywhere, or paste an image.
let dragDepth = 0;
window.addEventListener("dragenter", (e) => {
  if (e.dataTransfer && [...e.dataTransfer.types].includes("Files")) {
    dragDepth++;
    document.body.classList.add("dragging");
  }
});
window.addEventListener("dragleave", () => {
  if (--dragDepth <= 0) {
    dragDepth = 0;
    document.body.classList.remove("dragging");
  }
});
window.addEventListener("dragover", (e) => e.preventDefault());
window.addEventListener("drop", (e) => {
  e.preventDefault();
  dragDepth = 0;
  document.body.classList.remove("dragging");
  const f = e.dataTransfer && e.dataTransfer.files[0];
  if (f) openImport(f);
});
window.addEventListener("paste", (e) => {
  const f = e.clipboardData && [...e.clipboardData.files][0];
  if (f) openImport(f);
});

// ── Make unique ─────────────────────────────────────────────────────────────
// Change one cell at a time: the solver tries every cell where two solutions differ and keeps the
// change that leaves the fewest differences, until the puzzle has one solution.

let fixer = null;
const pictureText = () => Array.from({ length: H }, (_, y) => Array.from({ length: W }, (_, x) => (pic[y * W + x] ? "#" : ".")).join("")).join("\n");

function makeUnique() {
  if (fixer) return;
  const before = pic.slice();
  const wasW = W;
  const wasH = H;
  fixed = new Set();
  const w = new Worker("worker.js?v=dev", { type: "module" });
  fixer = w;
  let steps = 0;
  const send = () => w.postMessage({ module, kind: "step", text: pictureText(), engine: 2, id: ++steps });
  const finish = (title, body = "") => {
    w.terminate();
    fixer = null;
    const count = fixed.size;
    lastFix = count ? { undo: before, w: wasW, h: wasH, count } : null;
    if (!count) fixed = new Set();
    changed();
    if (!count) setStatus("warn", title, body);
  };
  setStatus("busy", "Making it unique…", "");
  send();
  w.onmessage = ({ data }) => {
    if (data.error || data.result.error) return finish("Could not finish", String(data.error || data.result.error));
    const r = data.result;
    if (r.unique) return finish("done");
    if (r.flip && steps < 80) {
      const i = r.flip[0] * W + r.flip[1];
      pic[i] ^= 1;
      if (fixed.has(i)) fixed.delete(i);
      else fixed.add(i);
      draw();
      $("verdict").textContent = `Making it unique… ${fixed.size} changed, ${r.after} cells still differ`;
      return send();
    }
    finish("Still ambiguous", `<p class="note">No single change helps from here. Try editing near the red cells yourself.</p>`);
  };
  w.onerror = (e) => finish("Could not finish", e.message || "the worker failed");
}

// Share and export.
function packed() {
  const bytes = new Uint8Array(Math.ceil((W * H) / 8));
  for (let i = 0; i < W * H; i++) if (pic[i]) bytes[i >> 3] |= 1 << (i & 7);
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function unpack(w, h, s) {
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/"));
  const next = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) next[i] = (bin.charCodeAt(i >> 3) >> (i & 7)) & 1;
  return next;
}
function hash() {
  return `#${W}x${H}:${packed()}`;
}
function save() {
  history.replaceState(null, "", hash());
  try {
    localStorage.setItem("hugi-picture", hash());
  } catch {}
}
function restore(h) {
  const m = /^#(\d+)x(\d+):([\w-]*)$/.exec(h || "");
  if (!m) return false;
  const w = +m[1];
  const hh = +m[2];
  if (w < 1 || hh < 1 || w > MAX || hh > MAX) return false;
  try {
    pic = unpack(w, hh, m[3]);
  } catch {
    return false;
  }
  W = w;
  H = hh;
  return true;
}
async function copy(text, button, label) {
  try {
    await navigator.clipboard.writeText(text);
    button.textContent = "Copied";
  } catch {
    window.prompt("Copy this:", text);
  }
  setTimeout(() => (button.textContent = label), 1200);
}
$("share").onclick = () => copy(location.origin + location.pathname + hash(), $("share"), "Copy link");
$("copy-clues").onclick = () => copy(puzzleText(), $("copy-clues"), "Copy clues");
function download(name, blob) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
$("download").onclick = () => download("puzzle.txt", new Blob([puzzleText()], { type: "text/plain" }));
$("png").onclick = () => canvas.toBlob((b) => download("puzzle.png", b));

// Theme and thread.
function applyTheme(t) {
  document.documentElement.dataset.theme = t;
  $("theme").textContent = t === "dark" ? "Day" : "Night";
  try {
    localStorage.setItem("hugi-theme", t);
  } catch {}
  draw();
}
$("theme").onclick = () => applyTheme(document.documentElement.dataset.theme === "dark" ? "light" : "dark");
function applyThread(n) {
  thread = n;
  document.querySelectorAll("[data-thread]").forEach((b) => b.setAttribute("aria-pressed", String(+b.dataset.thread === n)));
  try {
    localStorage.setItem("hugi-thread", String(n));
  } catch {}
  draw();
}
document.querySelectorAll("[data-thread]").forEach((b) => (b.onclick = () => applyThread(+b.dataset.thread)));
(() => {
  let t = null;
  let n = 1;
  try {
    t = localStorage.getItem("hugi-theme");
    n = +localStorage.getItem("hugi-thread") || 1;
  } catch {}
  document.documentElement.dataset.theme = t || (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
  $("theme").textContent = document.documentElement.dataset.theme === "dark" ? "Day" : "Night";
  thread = n;
  document.querySelectorAll("[data-thread]").forEach((b) => b.setAttribute("aria-pressed", String(+b.dataset.thread === n)));
})();

window.addEventListener("resize", draw);

// ── Start ───────────────────────────────────────────────────────────────────

(async () => {
  let ok = restore(location.hash);
  if (!ok) {
    try {
      ok = restore(localStorage.getItem("hugi-picture"));
    } catch {}
  }
  if (!ok) loadPicture(PICTURES.heart);
  syncInputs();
  draw();
  try {
    module = await WebAssembly.compileStreaming(fetch("hugi_web.wasm?v=dev"));
    hugi = await instantiate(module);
  } catch (e) {
    setStatus("bad", "Could not load the solver", String(e));
    return;
  }
  changed();
})();
