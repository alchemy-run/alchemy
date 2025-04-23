import { File } from "./file.js";

export type StaticHTMLFile = File;

/**
 * Creates a static HTML file
 *
 * @example
 * // Create an HTML file with content
 * const page = await StaticHTMLFile("index.html",
 *   `<!DOCTYPE html>
 *   <html lang="en">
 *   <head>
 *     <meta charset="UTF-8">
 *     <meta name="viewport" content="width=device-width, initial-scale=1.0">
 *     <title>My Website</title>
 *     <link rel="stylesheet" href="styles.css">
 *   </head>
 *   <body>
 *     <header>
 *       <h1>Welcome to My Website</h1>
 *     </header>
 *     <main>
 *       <p>This is the main content of the page.</p>
 *     </main>
 *     <footer>
 *       <p>&copy; 2024 My Company</p>
 *     </footer>
 *   </body>
 *   </html>`
 * );
 */
export function StaticHTMLFile(
  id: string,
  ...args: [content: string] | [path: string, content: string]
): Promise<StaticHTMLFile> {
  const [path, content] = args.length === 1 ? [id, args[0]] : args;
  return File(id, {
    path,
    content,
  });
}
