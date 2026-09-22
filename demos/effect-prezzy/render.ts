/**
 * Renders every deck item with Remotion and writes a presentation workspace
 * that `tcut present` opens directly:
 *
 *   out/presentation/presentation.json
 *   out/presentation/sources/<sha256>/step-<n>.mp4 + step-<n>.jpg
 *
 *   pnpm render                 # everything
 *   pnpm render title outline   # only these deck items (others are reused)
 *
 * Speaker notes come from `deck.ts` and the scene files; edits made in the
 * presenter's notes panel are replaced on the next render.
 */
import { bundle } from "@remotion/bundler";
import { renderMedia, renderStill, selectComposition } from "@remotion/renderer";
import { createHash } from "node:crypto";
import { cp, mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { deck } from "./deck.ts";
import type { SceneCapture } from "./shared/types.ts";

const root = import.meta.dirname;
const captureDir = path.join(root, "out", "capture");
const clipsDir = path.join(root, "out", "clips");
const presentationDir = path.join(root, "out", "presentation");
const only = new Set(process.argv.slice(2));

const exists = (file: string) => stat(file).then(() => true, () => false);

console.log("● bundling the Remotion project");
const serveUrl = await bundle({
  entryPoint: path.join(root, "remotion", "index.ts"),
  publicDir: captureDir,
});

await mkdir(clipsDir, { recursive: true });
const steps = [];
let start = 0;
let fps = 30;
let width = 1920;
let height = 1080;
for (const [index, item] of deck.entries()) {
  const clip = path.join(clipsDir, `${item.id}.mp4`);
  const poster = path.join(clipsDir, `${item.id}.jpg`);
  const composition = await selectComposition({ serveUrl, id: item.id, inputProps: {} });
  ({ fps, width, height } = composition);
  if (only.size === 0 || only.has(item.id) || !(await exists(clip))) {
    console.log(`● rendering ${item.id} (${(composition.durationInFrames / fps).toFixed(1)}s)`);
    let last = -1;
    await renderMedia({
      composition,
      serveUrl,
      codec: "h264",
      crf: 18,
      imageFormat: "jpeg",
      jpegQuality: 95,
      outputLocation: clip,
      inputProps: composition.props,
      onProgress: ({ progress }) => {
        const pct = Math.floor(progress * 4) * 25;
        if (pct !== last && pct < 100) console.log(`  ${(last = pct)}%`);
      },
    });
    await renderStill({
      composition,
      serveUrl,
      frame: 0,
      imageFormat: "jpeg",
      jpegQuality: 90,
      output: poster,
      inputProps: composition.props,
    });
  } else {
    console.log(`● reusing ${item.id}`);
  }
  const duration = composition.durationInFrames / fps;
  let title: string;
  let notes: string;
  if (item.kind === "slide") {
    ({ title, notes } = item);
  } else {
    const capture = JSON.parse(
      await readFile(path.join(captureDir, item.id, "scene.json"), "utf8"),
    ) as SceneCapture;
    ({ title, notes } = capture);
  }
  steps.push({
    id: item.id,
    title,
    notes,
    start,
    end: start + duration,
    clip: `step-${index + 1}.mp4`,
    poster: `step-${index + 1}.jpg`,
    source: { clip, poster },
  });
  start += duration;
}

// The workspace id fingerprints the clips, so the presenter never serves stale media.
const hash = createHash("sha256");
for (const step of steps) {
  hash.update(await readFile(step.source.clip));
  hash.update(await readFile(step.source.poster));
}
const id = hash.digest("hex");
const sources = path.join(presentationDir, "sources");
await rm(sources, { recursive: true, force: true });
await mkdir(path.join(sources, id), { recursive: true });
for (const step of steps) {
  await cp(step.source.clip, path.join(sources, id, step.clip));
  await cp(step.source.poster, path.join(sources, id, step.poster));
}
const manifest = {
  version: 1,
  id,
  title: "Alchemy",
  fps,
  width,
  height,
  duration: start,
  steps: steps.map(({ source: _, ...step }) => step),
};
const temp = path.join(presentationDir, `presentation.${process.pid}.json`);
await writeFile(temp, `${JSON.stringify(manifest, null, 2)}\n`);
await rename(temp, path.join(presentationDir, "presentation.json"));
const count = (await readdir(path.join(sources, id))).length / 2;
console.log(`✔ ${count} scenes, ${start.toFixed(1)}s → out/presentation (pnpm present)`);
