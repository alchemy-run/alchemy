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
export type JsonFile = File;

export function JsonFile(id: string, content: any): Promise<JsonFile> {
  return File(id, {
    path: id,
    content: JSON.stringify(content, null, 2),
  });
}
