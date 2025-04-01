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
export type TextFile = File;

export function TextFile(id: string, content: string): Promise<TextFile> {
  return File(id, {
    path: id,
    content,
  });
}
