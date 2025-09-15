import { access } from "node:fs/promises";
import pathe from "pathe";

export async function exists(...path: string[]): Promise<boolean> {
  try {
    await access(pathe.join(...path));
    return true;
  } catch {
    return false;
  }
}

export async function anyExists(
  base: string,
  files: string[],
): Promise<boolean> {
  return await Promise.all(files.map((file) => exists(base, file))).then(
    (results) => results.some(Boolean),
  );
}
