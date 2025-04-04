import { File } from "./file";

/**
 * Creates a JSON file with formatted content
 *
 * @example
 * // Create a JSON configuration file
 * const config = await StaticJsonFile("config.json", {
 *   api: {
 *     endpoint: "https://api.example.com",
 *     version: "v1"
 *   },
 *   features: ["auth", "logging"]
 * });
 */
export type StaticJsonFile = File;

export async function StaticJsonFile(
  id: string,
  ...args: [content: any] | [path: string, content: any]
): Promise<StaticJsonFile> {
  const [path, content] = args.length === 1 ? [id, args[0]] : args;
  const prettier = await import("prettier");
  return File(id, {
    path,
    content: await prettier.format(JSON.stringify(content), {
      parser: "json",
      editor: {
        tabWidth: 2,
        indentWidth: 2,
      },
    }),
  });
}
