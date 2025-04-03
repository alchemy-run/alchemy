import { File } from "./file";

/**
 * Creates a JSON file with formatted content
 *
 * @example
 * // Create a JSON configuration file
 * const config = await JsonFile("config.json", {
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
  content: any,
): Promise<StaticJsonFile> {
  const prettier = await import("prettier");
  return File(id, {
    path: id,
    content: await prettier.format(JSON.stringify(content), {
      parser: "json",
      editor: {
        tabWidth: 2,
        indentWidth: 2,
      },
    }),
  });
}
