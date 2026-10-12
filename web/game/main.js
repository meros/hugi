// The hash router of the page and the shell of the game. The Maker (app.js) and the screens meet here
// only through the DOM: body.dataset.view, the hugi:route event and the hugi:theme event.
//
//   hash                          view
//   empty, #play                  play    (the quilt)
//   #play/<id>                    puzzle  {kind: "pack", id}
//   #daily                        puzzle  {kind: "daily"}
//   #solve:WxH:bits[&t=..&a=..]   puzzle  {kind: "shared", hash}
//   #make, #WxH:bits              make    (the Maker; every old share link keeps working)

import { loadSolver } from "../wasm.js?v=dev";

// Filled during boot. The screens' modules add the rest (pack, save, engine).
export const ctx = { pack: null, save: null, solver: null, engine: null };

const screens = new Map(); // view -> {show(params), hide()}
let current = null; // {view, params, hash} of the route that is shown

const $ = (id) => document.getElementById(id);

export function registerScreen(view, screen) {
  screens.set(view, screen);
  if (current && current.view === view) enter(); // registered after the route was shown
}

export function go(hash) {
  const next = hash.startsWith("#") ? hash : "#" + hash;
  if (location.hash === next) route();
  else location.hash = next;
}

export function parse(hash) {
  const h = hash || "";
  if (h === "" || h === "#" || h === "#play") return { view: "play", params: {} };
  let m = /^#play\/([^/]+)$/.exec(h);
  if (m) return { view: "puzzle", params: { kind: "pack", id: decodeURIComponent(m[1]) } };
  if (h === "#daily") return { view: "puzzle", params: { kind: "daily" } };
  if (/^#solve:\d+x\d+:[\w-]*(&.*)?$/.test(h)) return { view: "puzzle", params: { kind: "shared", hash: h } };
  if (h === "#make" || /^#\d+x\d+:[\w-]*$/.test(h)) return { view: "make", params: {} };
  return { view: "play", params: {} };
}

function leave() {
  if (current) screens.get(current.view)?.hide?.();
}

function enter() {
  const { view, params } = current;
  const screen = screens.get(view);
  const root = $("view-" + view);
  if (screen) {
    root?.querySelector(":scope > .placeholder")?.remove();
    screen.show(params);
  } else if (root && view !== "make") {
    placeholder(root, view);
  }
}

function placeholder(root, view) {
  if (root.querySelector(":scope > .placeholder")) return;
  const card = document.createElement("section");
  card.className = "card placeholder";
  card.innerHTML = view === "play" ? "<h2>Play mode is being built</h2>" : "<h2>This puzzle screen is being built</h2>";
  const p = document.createElement("p");
  p.className = "muted";
  p.append("In the meantime, ");
  const a = document.createElement("a");
  a.href = "#make";
  a.textContent = "draw your own picture in the Maker";
  p.append(a, ".");
  card.append(p);
  root.append(card);
}

function route() {
  const next = { ...parse(location.hash), hash: location.hash };
  leave();
  current = next;
  document.body.dataset.view = next.view;
  const active = next.view === "make" ? "nav-make" : "nav-play";
  for (const id of ["nav-play", "nav-make"]) {
    const a = $(id);
    if (id === active) a.setAttribute("aria-current", "page");
    else a.removeAttribute("aria-current");
  }
  enter();
  document.dispatchEvent(new CustomEvent("hugi:route", { detail: { view: next.view, params: next.params, hash: next.hash } }));
}

// The skein count in the header; Play views show it, the Maker hides it.
export function setSkeins(n) {
  const el = $("skeins");
  el.textContent = n == null ? "" : String(n);
  if (n == null) el.removeAttribute("aria-label");
  else el.setAttribute("aria-label", `${n} ${n === 1 ? "skein" : "skeins"}`);
}

// A short message at the bottom of the page, announced politely to screen readers.
export function toast(message, ms = 2600) {
  const el = document.createElement("div");
  el.className = "toast";
  el.textContent = message;
  $("toasts").append(el);
  setTimeout(() => el.classList.add("out"), ms);
  setTimeout(() => el.remove(), ms + 400);
}

// Modules of the screens, loaded in boot(). Each calls registerScreen() when it is evaluated.
// WP7a and WP7b add their lines here, for example "./quilt.js?v=dev" and "./play.js?v=dev".
const SCREEN_MODULES = [];

export const ready = (async () => {
  window.addEventListener("hashchange", route);
  route();
  try {
    ctx.solver = await loadSolver();
  } catch (e) {
    console.error("The solver did not load:", e);
  }
  await Promise.all(SCREEN_MODULES.map((m) => import(m)));
})();
