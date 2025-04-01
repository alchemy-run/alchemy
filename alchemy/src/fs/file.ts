import fs from "node:fs";
import path from "node:path";
import type { Context } from "../context";
import { Resource } from "../resource";
import { ignore } from "../util/ignore";

import { alchemy } from "../alchemy";

declare module "../alchemy" {
  interface Alchemy {
    /**
     * Creates a reference to a file in the filesystem.
     * Used in template string interpolation to include file contents,
     * commonly for documentation generation.
     *
     * @param path Path to the file
     * @returns Promise resolving to a FileRef
     *
     * @example
     * // Include a file in documentation generation
     * await Document("api-docs", {
     *   prompt: await alchemy`
     *     Generate docs using the contents of:
     *     ${alchemy.file("./README.md")}
     *   `
     * });
     */
    file(path: string): Promise<FileRef>;

    /**
     * Creates a collection of files with their contents.
     * Used in template string interpolation to include multiple file contents,
     * commonly for bulk documentation generation.
     *
     * @param paths Array of file paths to include in collection
     * @returns Promise resolving to a FileCollection
     *
     * @example
     * // Include multiple source files in documentation generation
     * await Document("provider-docs", {
     *   prompt: await alchemy`
     *     Generate comprehensive docs for these files:
     *     ${alchemy.files([
     *       "src/types.ts",
     *       "src/resource.ts",
     *       "src/provider.ts"
     *     ])}
     *   `
     * });
     */
    files(paths: string[]): Promise<FileCollection>;
    files(path: string, ...paths: string[]): Promise<FileCollection>;
  }
}

/**
 * Reference to a file in the filesystem
 */
export type FileRef = {
  /**
   * Type identifier for FileRef
   */
  kind: "fs::FileRef";
  /**
   * Path to the file
   */
  path: string;
};

export function isFileRef(value: unknown): value is FileRef {
  return (
    typeof value === "object" &&
    value !== null &&
    "kind" in value &&
    value.kind === "fs::FileRef"
  );
}

/**
 * Collection of files with their contents
 */
export type FileCollection = {
  /**
   * Type identifier for FileCollection
   */
  type: "fs::FileCollection";
  /**
   * Map of relative paths to file contents
   */
  files: {
    [relativePath: string]: string;
  };
};

export function isFileCollection(value: unknown): value is FileCollection {
  return (
    typeof value === "object" &&
    value !== null &&
    "type" in value &&
    value.type === "fs::FileCollection"
  );
}

alchemy.file = async (path: string) => ({
  kind: "fs::FileRef",
  path,
});

alchemy.files = async (
  ...args: [paths: string[]] | [...paths: string[]]
): Promise<FileCollection> => {
  const paths: string[] =
    typeof args[0] === "string" ? (args as string[]) : args[0];
  return {
    type: "fs::FileCollection",
    files: Object.fromEntries(
      await Promise.all(
        paths.map(async (path) => [
          path,
          await fs.promises.readFile(path, "utf-8"),
        ]),
      ),
    ),
  };
};

/**
 * Base file resource type
 */
export interface File extends Resource<"fs::File"> {
  /**
   * Path to the file
   */
  path: string;
  /**
   * Content of the file
   */
  content: string;
}

/**
 * File Resource
 *
 * Creates and manages files in the filesystem with automatic directory creation
 * and proper cleanup on deletion.
 *
 * @example
 * // Create a simple text file
 * const config = await File("config.txt", {
 *   path: "config.txt",
 *   content: "some configuration data"
 * });
 *
 * @example
 * // Create a file in a nested directory
 * const log = await File("logs/app.log", {
 *   path: "logs/app.log",
 *   content: "application log entry"
 * });
 */
export const File = Resource(
  "fs::File",
  async function (
    this: Context<File>,
    id: string,
    props: {
      path: string;
      content: string;
    },
  ): Promise<File> {
    const filePath = props?.path ?? id;
    if (this.phase === "delete") {
      await ignore("ENOENT", async () => fs.promises.unlink(filePath));
      return this.destroy();
    } else {
      await fs.promises.mkdir(path.dirname(filePath), {
        recursive: true,
      });
      await fs.promises.writeFile(filePath, props.content);
    }
    return this({
      path: filePath,
      content: props.content,
    });
  },
);

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

/**
 * Creates a YAML file with formatted content
 *
 * @example
 * // Create a YAML configuration file
 * const config = await YamlFile("config.yaml", {
 *   server:
 *     host: "localhost"
 *     port: 3000
 *   database:
 *     url: "postgresql://localhost:5432/db"
 *     pool:
 *       min: 1
 *       max: 10
 * });
 */
export type YamlFile = File;

export async function YamlFile(id: string, content: any): Promise<YamlFile> {
  const yaml = await import("yaml");
  return File(id, {
    path: id,
    content: yaml.stringify(content),
  });
}

/**
 * Creates a TypeScript file with formatted content using prettier
 *
 * @example
 * // Create a TypeScript file
 * const component = await TypeScriptFile("Component.ts", `
 *   interface Props {
 *     name: string;
 *     age: number;
 *   }
 *
 *   export function Component({ name, age }: Props) {
 *     return <div>Hello {name}, you are {age} years old</div>;
 *   }
 * `);
 */
export type TypeScriptFile = File;

export async function TypeScriptFile(
  id: string,
  content: string,
): Promise<TypeScriptFile> {
  const prettier = await import("prettier");
  return File(id, {
    path: id,
    content: await prettier.format(content, {
      parser: "typescript",
      editor: {
        tabWidth: 2,
        indentWidth: 2,
      },
    }),
  });
}
