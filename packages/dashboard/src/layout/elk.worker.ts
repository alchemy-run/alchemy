/**
 * Web Worker entry: runs ELK layered layout off the main thread. Vite
 * bundles this via `new Worker(new URL("./elk.worker.ts", import.meta.url),
 * { type: "module" })` in `layoutWorker.ts`.
 */
import ELK from "elkjs/lib/elk.bundled.js";
import {
  positionsOf,
  repackComponents,
  toElkGraph,
  type LayoutRequestMessage,
  type LayoutResponseMessage,
} from "./elkGraph.ts";

const elk = new ELK();

// The dashboard tsconfig compiles against the DOM lib (no WebWorker lib —
// the two conflict), so type the dedicated-worker scope structurally.
const scope = self as unknown as {
  onmessage: ((event: MessageEvent<LayoutRequestMessage>) => void) | null;
  postMessage: (message: LayoutResponseMessage) => void;
};

scope.onmessage = (event) => {
  const request = event.data;
  void elk
    .layout(toElkGraph(request.fqns, request.edges, request.aspectRatio))
    .then((root) => {
      scope.postMessage({
        id: request.id,
        ok: true,
        positions: repackComponents(
          positionsOf(root),
          request.edges,
          request.aspectRatio,
        ),
      });
    })
    .catch((error: unknown) => {
      scope.postMessage({ id: request.id, ok: false, error: String(error) });
    });
};
