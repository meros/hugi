// One engine in one Web Worker: the page races several of these and ends the losers.
import { instantiate } from "./hugi.js?v=dev";

self.onmessage = async ({ data: { module, text, engine, id, kind } }) => {
  try {
    const hugi = await instantiate(module);
    const t = performance.now();
    const result = kind === "step" ? hugi.uniqueStep(text, engine) : hugi.solve(text, engine);
    result.seconds = (performance.now() - t) / 1000;
    self.postMessage({ id, engine, result });
  } catch (e) {
    self.postMessage({ id, engine, error: String(e) });
  }
};
