// The game worker: one long-lived worker that instantiates the shared solver module once and serves
// hint, rate and solve. The page asks one request at a time: {id, op, text, engine?}.
import { instantiate } from "../hugi.js?v=dev";

let ready = null;

self.onmessage = async ({ data: { id, op, module, text, engine } }) => {
  if (op === "init") {
    ready = instantiate(module);
    ready.catch(() => {}); // the error is reported to the first request that needs the instance
    return;
  }
  try {
    const hugi = await ready;
    if (!hugi) throw new Error("the worker was not initialised");
    const result = op === "solve" ? hugi.solve(text, engine) : op === "hint" ? hugi.hint(text) : op === "rate" ? hugi.rate(text) : null;
    if (result === null) throw new Error(`unknown operation ${op}`);
    self.postMessage({ id, result });
  } catch (e) {
    self.postMessage({ id, error: String(e) });
  }
};
