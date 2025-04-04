import { File } from "./file";
/**
 * Creates a YAML file with formatted content
 *
 * @example
 * // Create a YAML configuration file
 * const config = await StaticYamlFile("config.yaml", {
 *   server: {
 *     host: "localhost",
 *     port: 3000
 *   },
 *   database: {
 *     url: "postgresql://localhost:5432/db",
 *     pool: {
 *       min: 1,
 *       max: 10
 *     }
 *   }
 * });
 */
export type StaticYamlFile = File;

export async function StaticYamlFile(
  id: string,
  ...args: [content: any] | [path: string, content: any]
): Promise<StaticYamlFile> {
  const [path, content] = args.length === 1 ? [id, args[0]] : args;
  const yaml = await import("yaml");
  return File(id, {
    path,
    content: yaml.stringify(content),
  });
}
