/**
 * `pnpm dev`: the fast loop for designing the slideshow.
 *
 * - Remotion Studio (http://localhost:3000) hot-reloads every composition
 *   when a component in remotion/ changes.
 * - intro/watch.ts rebuilds the intro whenever intro/steps.ts or a snippet
 *   changes; Studio's `intro-live` composition picks it up without a reload.
 *
 * Extra arguments go to Studio, e.g. `pnpm dev --port 3300`.
 */
import { spawn } from "node:child_process";
import path from "node:path";

const dir = import.meta.dirname;
const bin = path.join(dir, "node_modules", ".bin");
const children = [
  spawn(process.execPath, [path.join(dir, "intro", "watch.ts")], { stdio: "inherit" }),
  spawn(path.join(bin, "remotion"), ["studio", "remotion/index.ts", ...process.argv.slice(2)], {
    cwd: dir,
    stdio: "inherit",
  }),
];
const stop = () => {
  for (const child of children) child.kill();
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
for (const child of children) child.on("exit", stop);
