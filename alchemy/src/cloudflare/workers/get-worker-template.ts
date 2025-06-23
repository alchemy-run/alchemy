import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export async function getWorkerTemplate(name: "do-state-store") {
  const dir = path.dirname(fileURLToPath(import.meta.url));
  const template = await readFile(
    path.join(dir, "..", "..", "..", "workers", `${name}.js`),
    "utf8",
  );
  return new File([template], `${name}.js`, {
    type: "application/javascript+module",
  });
}
