// One compile of the solver for the Maker and the game. The first call starts the fetch; later calls share it.
import { instantiate } from "./hugi.js?v=dev";

let loading = null;

export function loadSolver() {
  loading ??= (async () => {
    const module = await WebAssembly.compileStreaming(fetch("hugi_web.wasm?v=dev"));
    return { module, hugi: await instantiate(module) };
  })();
  loading.catch(() => (loading = null)); // a failed load can be tried again
  return loading;
}
