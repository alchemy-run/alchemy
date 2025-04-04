import { File } from "./file";

export type StaticCSSFile = File;

/**
 * Creates a static CSS file
 *
 * @example
 * // Create a CSS file with styles
 * const styles = await StaticCSSFile("styles.css",
 *   `.container {
 *     max-width: 1200px;
 *     margin: 0 auto;
 *     padding: 0 1rem;
 *   }
 *
 *   .button {
 *     background-color: #0062ff;
 *     color: white;
 *     border: none;
 *     padding: 0.5rem 1rem;
 *     border-radius: 4px;
 *   }`
 * );
 */
export function StaticCSSFile(
  id: string,
  ...args: [content: string] | [path: string, content: string]
): Promise<StaticCSSFile> {
  const [path, content] = args.length === 1 ? [id, args[0]] : args;
  return File(id, {
    path,
    content,
  });
}
