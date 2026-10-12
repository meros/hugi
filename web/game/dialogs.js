// The two dialogs of the Play screen: Achievements, and Your progress (download, load and erase the save).
// Both are <dialog>s opened with showModal(), so the browser traps focus, closes on Esc and inerts the page.

import { ctx, toast } from "./main.js?v=dev";
import { ACHIEVEMENTS, ACHIEVEMENT_REWARD, today } from "./rules.js?v=dev";
import { exportSave, importSave, freshSave, writeSave, saveStatus, solvedCount } from "./save.js?v=dev";

/** Builds an element: attrs are set as properties (className, textContent, ...) except data-/aria- ones; kids may be strings. */
export function el(tag, attrs = {}, ...kids) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k.startsWith("data-") || k.startsWith("aria-") || k === "role" || k === "for" || k === "inert") node.setAttribute(k, v === true ? "" : v);
    else node[k] = v;
  }
  node.append(...kids.flat().filter((x) => x != null && x !== false));
  return node;
}

const plural = (n, one, many = one + "s") => `${n} ${n === 1 ? one : many}`;

// Tells the screens that the save changed under them (a load or an erase).
const changed = () => document.dispatchEvent(new CustomEvent("hugi:save"));

// Opens a modal dialog and resolves when it is closed, after it is gone from the page. `build(dialog, close)` fills it.
function modal(id, title, build) {
  return new Promise((resolve) => {
    const dialog = el("dialog", { id, className: "q-dialog", "aria-labelledby": id + "-title" });
    const close = () => dialog.close();
    build(dialog, close, title);
    dialog.addEventListener("close", () => {
      dialog.remove();
      resolve();
    });
    document.body.append(dialog);
    dialog.showModal();
    // A long dialog opens at its top: the title is focused when there is nothing to do before the Close button.
    dialog.querySelector("h2[tabindex]")?.focus({ preventScroll: true });
  });
}

const closeButton = (close, label = "Close") => el("button", { type: "button", className: "primary", onclick: close }, label);

// --- Achievements ---

// Progress toward the achievements that count something: [done, needed].
function progressOf(save, id) {
  const stats = save.stats;
  if (id === "brisk") return [stats.parStars, 10];
  if (id === "fine") return [stats.threeStars, 25];
  if (id === "week") return [save.daily.best, 7];
  return null;
}

export function openAchievements() {
  const save = ctx.save;
  const earned = ACHIEVEMENTS.filter((a) => save.ach[a.id]).length;
  return modal("achievements", "Achievements", (dialog, close) => {
    const list = el(
      "ul",
      { className: "q-ach" },
      ACHIEVEMENTS.map((a) => {
        const day = save.ach[a.id];
        const prog = progressOf(save, a.id);
        const status = day ? `Earned ${day}` : prog ? `${Math.min(prog[0], prog[1])} of ${prog[1]} so far` : "Not yet";
        return el(
          "li",
          { className: day ? "earned" : "" },
          el("span", { className: "q-ach-mark", "aria-hidden": "true" }, day ? "✓" : "○"),
          el("span", { className: "q-ach-body" }, el("strong", {}, a.name), el("span", {}, a.text), el("span", { className: "muted" }, status)),
        );
      }),
    );
    dialog.append(
      el("h2", { id: "achievements-title", tabIndex: -1 }, "Achievements"),
      el("p", { className: "muted" }, `${earned} of ${ACHIEVEMENTS.length} earned. Each one pays ${ACHIEVEMENT_REWARD} skeins, once.`),
      list,
      el("div", { className: "actions" }, closeButton(close)),
    );
  });
}

// --- Your progress ---

function download(save) {
  const name = `hugi-save-${today()}.json`;
  const a = el("a", { href: URL.createObjectURL(new Blob([exportSave(save)], { type: "application/json" })), download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  return name;
}

// Replaces the live save, keeps it in storage and tells the screens.
function replaceSave(next) {
  ctx.save = next;
  if (!writeSave(next)) toast(saveStatus(next).note ?? "The save could not be written.");
  changed();
}

export function openProgress() {
  return modal("progress", "Your progress", (dialog, close) => {
    const body = el("div", { className: "q-steps" });
    dialog.append(el("h2", { id: "progress-title" }, "Your progress"), body);

    // Each step replaces the body of the dialog and puts focus on the safe button of that step.
    const step = (...nodes) => body.replaceChildren(...nodes.filter(Boolean));
    const focus = (node) => queueMicrotask(() => node.focus());

    const home = () => {
      const save = ctx.save;
      const pack = ctx.pack;
      const inQuilt = pack ? pack.puzzles.filter((p) => save.solved[p.id]).length : 0;
      const starTotal = Object.values(save.solved).reduce((n, s) => n + s.stars, 0);
      const note = saveStatus(save).note;
      const status = el("p", { className: "muted", role: "status" });
      const first = el(
        "button",
        {
          type: "button",
          onclick: () => {
            status.textContent = `Downloaded ${download(ctx.save)}.`;
          },
        },
        "Download save",
      );
      step(
        el(
          "ul",
          { className: "q-facts" },
          el("li", {}, el("span", {}, "Pictures solved"), el("strong", {}, String(solvedCount(save)))),
          pack && el("li", {}, el("span", {}, "In the quilt"), el("strong", {}, `${inQuilt} of ${pack.puzzles.length}`)),
          el("li", {}, el("span", {}, "Stars"), el("strong", {}, String(starTotal))),
          el("li", {}, el("span", {}, "Skeins"), el("strong", {}, String(save.skeins))),
          el("li", {}, el("span", {}, "Longest daily streak"), el("strong", {}, plural(save.daily.best, "day"))),
        ),
        el("p", { className: "muted" }, "Your progress lives in this browser only. Download a save to keep a copy or to move to another device."),
        note && el("p", { className: "q-note" }, note),
        el(
          "div",
          { className: "actions" },
          first,
          el("button", { type: "button", onclick: loadStep }, "Load save"),
          el("button", { type: "button", className: "danger", onclick: eraseStep }, "Start over"),
          closeButton(close),
        ),
        status,
      );
    };

    const loadStep = () => {
      const error = el("p", { className: "error", role: "alert" });
      const text = el("textarea", { id: "load-text", spellcheck: false, placeholder: '{ "v": 1, ... }' });
      const file = el("input", {
        id: "load-file",
        type: "file",
        accept: ".json,application/json,text/plain",
        onchange: async () => {
          const f = file.files[0];
          if (!f) return;
          try {
            text.value = await f.text();
            error.textContent = "";
          } catch {
            error.textContent = "That file could not be read.";
          }
        },
      });
      const go = el("button", { type: "button", className: "primary" }, "Load");
      go.onclick = () => {
        const res = importSave(text.value.trim());
        if (res.error) {
          error.textContent = res.error;
          text.focus();
          return;
        }
        confirmLoad(res);
      };
      step(
        el("h3", {}, "Load a save"),
        el("p", { className: "muted" }, "Choose a save file, or paste its text. Loading replaces your current quilt."),
        el("label", { className: "q-field", for: "load-file" }, "Save file", file),
        el("label", { className: "q-field", for: "load-text" }, "Or paste the text", text),
        error,
        el("div", { className: "actions" }, el("button", { type: "button", onclick: home }, "Back"), go),
      );
      focus(file);
    };

    const confirmLoad = (next) => {
      const keep = el("button", { type: "button", className: "primary", onclick: home }, "Keep mine");
      step(
        el("h3", {}, "Replace your quilt?"),
        el(
          "p",
          {},
          `You have ${plural(solvedCount(ctx.save), "solved picture")} now. This save has ${plural(solvedCount(next), "solved picture")}. Loading it replaces yours, and that cannot be undone.`,
        ),
        el(
          "div",
          { className: "actions" },
          keep,
          el(
            "button",
            {
              type: "button",
              className: "danger",
              onclick: () => {
                replaceSave(next);
                close();
                toast(`Save loaded: ${plural(solvedCount(next), "solved picture")}.`);
              },
            },
            "Load this save",
          ),
        ),
      );
      focus(keep);
    };

    const eraseStep = () => {
      const keep = el("button", { type: "button", className: "primary", onclick: home }, "Keep my quilt");
      const save = ctx.save;
      step(
        el("h3", {}, "Start over?"),
        el(
          "p",
          {},
          `This erases ${plural(solvedCount(save), "solved picture")}, ${plural(save.skeins, "skein")}, your streak and your boards in progress. It cannot be undone. Download a save first if you may want it back.`,
        ),
        el(
          "div",
          { className: "actions" },
          keep,
          el("button", { type: "button", onclick: () => download(ctx.save) }, "Download first"),
          el(
            "button",
            {
              type: "button",
              className: "danger",
              onclick: () => {
                replaceSave(freshSave());
                close();
                toast("Starting from a clean quilt.");
              },
            },
            "Erase everything",
          ),
        ),
      );
      focus(keep);
    };

    home();
  });
}
