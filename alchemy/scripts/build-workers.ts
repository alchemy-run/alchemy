import { readdir } from "node:fs/promises";
import path from "node:path";
import { bundle } from "../src/esbuild/bundle";

const WORKERS_DIR = path.join(__dirname, "..", "workers");

const workers = await readdir(WORKERS_DIR);

for (const worker of workers) {
  if (!worker.endsWith(".ts")) {
    continue;
  }
 await bundle({
    entryPoint: path.join(WORKERS_DIR, worker),
    outdir: WORKERS_DIR,
    bundle: true,
    format: "esm",
    target: "es2022",
    external: ["cloudflare:*", "node:crypto"],
  });
}