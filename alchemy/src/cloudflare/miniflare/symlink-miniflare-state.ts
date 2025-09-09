import fs from "node:fs/promises";
import path from "node:path";
import { getDefaultPersistPath } from "./paths.ts";

export async function writeMiniflareSymlink(rootDir: string, cwd: string) {
  const target = path.resolve(getDefaultPersistPath(cwd));
  await fs.mkdir(target, { recursive: true });
  if (cwd === process.cwd()) {
    return;
  }
  const persistPath = path.resolve(cwd, getDefaultPersistPath(rootDir));
  console.log("link", target, persistPath);
  await fs.mkdir(path.dirname(persistPath), { recursive: true });
  await fs.symlink(target, persistPath).catch((e) => {
    if (e.code !== "EEXIST") {
      throw e;
    }
  });
}
