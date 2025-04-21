import fs from "node:fs/promises";

export async function rm(path: string) {
  try {
    await fs.rm(path, { recursive: true, force: true });
  } catch (error: any) {
    if (error.code !== "ENOENT") {
      throw error;
    }
  }
}
