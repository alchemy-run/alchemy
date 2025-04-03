import { File } from "./file";

/**
 * Creates a plain text file
 *
 * @example
 * // Create a text file with content
 * const readme = await TextFile("README.md",
 *   "# Project Name\n\nProject description goes here."
 * );
 */
export type StaticTextFile = File;

export function StaticTextFile(
  id: string,
  content: string,
): Promise<StaticTextFile> {
  return File(id, {
    path: id,
    content,
  });
}
