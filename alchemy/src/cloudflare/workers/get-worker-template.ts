import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export async function getWorkerTemplate(name: "do-state-store") {
  const dir = dirname(fileURLToPath(import.meta.url));
  console.log("dir", dir);
  const path = join(dir, "..", "..", "..", "workers", `${name}.js`);
  console.log("path", path);
  const template = await readFile(path, "utf8");
  return new File([template], `${name}.js`, {
    type: "application/javascript+module",
  });
}
