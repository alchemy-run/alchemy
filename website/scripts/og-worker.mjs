/**
 * Worker-thread renderer for OG card PNGs.
 *
 * The og endpoint (src/pages/og/[...slug].png.ts) serializes each card's
 * satori element tree (plain JSON — satori only reads `type`/`props`) and
 * fans the renders out across a pool of these workers, so the ~4k
 * satori→resvg renders run on all cores instead of serially on the build's
 * main thread.
 *
 * `workerData.fonts` carries `{ name, path, weight, style }` — each worker
 * reads the font files once at startup.
 */
import { readFileSync } from "node:fs";
import { parentPort, workerData } from "node:worker_threads";
import { Resvg } from "@resvg/resvg-js";
import satori from "satori";

const fonts = workerData.fonts.map(({ path, ...font }) => ({
  ...font,
  data: readFileSync(path),
}));

parentPort.on("message", async ({ id, tree }) => {
  try {
    const svg = await satori(tree, { width: 1200, height: 630, fonts });
    const png = new Resvg(svg, { fitTo: { mode: "width", value: 1200 } })
      .render()
      .asPng();
    parentPort.postMessage({ id, png });
  } catch (error) {
    parentPort.postMessage({ id, error: String(error?.stack ?? error) });
  }
});
