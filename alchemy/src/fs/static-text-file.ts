import { File } from "./file.js";

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
  ...args: [content: string] | [path: string, content: string]
): Promise<StaticTextFile> {
  const [path, content] = args.length === 1 ? [id, args[0]] : args;
  return File(id, {
    path,
    content,
  });
}
