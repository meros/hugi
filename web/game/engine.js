// The solver calls of the game: hints, ratings and the uniqueness check in one long-lived worker,
// and the clue status on the main thread. Without Worker the calls run on the main thread.

import { instantiate } from "../hugi.js?v=dev";
import { cluesText, stateText } from "../grid.js?v=dev";

export const TIMEOUT_MS = 5000;
const UNIQUE_ENGINE = 2; // the learning solver with block-position variables

/** @typedef {{w: number, h: number, rows: number[][], cols: number[][]}} SolverPuzzle */

const boardText = (puzzle, state) => `${cluesText(puzzle)}${stateText(puzzle.w, puzzle.h, state)}`;

// The solver answers {error} for bad input; the callers get a thrown Error.
function checked(result) {
  if (result?.error) throw new Error(result.error);
  return result;
}

export class Engine {
  /**
   * @param {WebAssembly.Module} module the compiled solver, shared with the main thread
   * @param {{Worker?: typeof Worker, url?: string, timeout?: number}} [options] Worker: undefined uses the
   *   global one, null forces the main thread; the tests pass a fake
   */
  constructor(module, { Worker = globalThis.Worker, url = "game/worker.js?v=dev", timeout = TIMEOUT_MS } = {}) {
    this.module = module;
    this.timeout = timeout;
    this._Worker = Worker;
    this._url = url;
    this._next = 1;
    this._pending = new Map(); // id -> {resolve, reject, timer}
    this._worker = null;
    this._local = null; // the main-thread instance, when there is no worker
    this._start();
  }

  _start() {
    if (!this._Worker) return;
    try {
      const worker = new this._Worker(this._url, { type: "module" });
      worker.onmessage = ({ data }) => this._answer(data);
      worker.onerror = () => this._replace("the solver worker failed");
      worker.postMessage({ id: 0, op: "init", module: this.module });
      this._worker = worker;
    } catch {
      this._worker = null; // the page still plays, on the main thread
    }
  }

  // Ends the worker, fails what it still owed, and starts a new one for the next request.
  _replace(why) {
    this._worker?.terminate?.();
    this._worker = null;
    for (const { reject, timer } of this._pending.values()) {
      clearTimeout(timer);
      reject(new Error(why));
    }
    this._pending.clear();
    this._start();
  }

  _answer({ id, result, error }) {
    const job = this._pending.get(id);
    if (!job) return; // a late answer to a request that timed out
    this._pending.delete(id);
    clearTimeout(job.timer);
    if (error !== undefined) job.reject(new Error(error));
    else job.resolve(result);
  }

  // Resolves with the result; rejects with {timeout: true} after the cap, and then replaces the worker.
  _ask(op, text, engine) {
    if (!this._worker) return this._askLocal(op, text, engine);
    const id = this._next++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const job = this._pending.get(id);
        if (!job) return;
        this._pending.delete(id);
        job.reject({ timeout: true });
        this._replace("the solver worker was replaced");
      }, this.timeout);
      this._pending.set(id, { resolve, reject, timer });
      this._worker.postMessage({ id, op, text, engine });
    });
  }

  async _askLocal(op, text, engine) {
    this._local ??= instantiate(this.module);
    const hugi = await this._local;
    return op === "solve" ? hugi.solve(text, engine) : op === "hint" ? hugi.hint(text) : hugi.rate(text);
  }

  /** The easiest next move for the board (the Move JSON of docs/game-design.md §2). */
  async hint(puzzle, state) {
    try {
      return checked(await this._ask("hint", boardText(puzzle, state)));
    } catch (e) {
      if (e?.timeout) throw new Error("The hint took too long.");
      throw e;
    }
  }

  /** The rating of a puzzle, or {timeout: true} after 5 s. */
  async rate(puzzle) {
    try {
      return checked(await this._ask("rate", cluesText(puzzle)));
    } catch (e) {
      if (e?.timeout) return { timeout: true };
      throw e;
    }
  }

  /** true for one solution, false for several, null on timeout. */
  async unique(puzzle) {
    try {
      const result = checked(await this._ask("solve", cluesText(puzzle), UNIQUE_ENGINE));
      return result.timed_out ? null : result.unique;
    } catch (e) {
      if (e?.timeout) return null;
      throw e;
    }
  }
}

/** The status of every clue of the board: {rows, cols}, 0 open, 1 impossible, 2 done. Runs on the given instance. */
export function lineStatus(hugi, puzzle, state) {
  return checked(hugi.lineStatus(boardText(puzzle, state)));
}
