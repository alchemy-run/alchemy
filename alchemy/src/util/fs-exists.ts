import fs from "node:fs/promises";

/**
 * Check if a file or directory exists
 * Uses fs.access which is available in all Node.js versions
 */
export async function fsExists(path: string): Promise<boolean> {
  try {
    await fs.access(path);
    return true;
  } catch {
    return false;
  }
}
