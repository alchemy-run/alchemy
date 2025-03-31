import fs from "node:fs";
import path from "node:path";
import type { Context } from "../context";
import { Resource } from "../resource";
import { ignore } from "../util/ignore";

import { alchemy } from "../alchemy";

declare module "../alchemy" {
  interface Alchemy {
    file(path: string): Promise<FileRef>;
    files(paths: string[]): Promise<FileCollection>;
    files(path: string, ...paths: string[]): Promise<FileCollection>;
  }
}

export type FileRef = {
  kind: "fs::FileRef";
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

export type FileCollection = {
  type: "fs::FileCollection";
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

export interface File extends Resource<"fs::File"> {
  path: string;
  content: string;
}

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

export type JsonFile = File;

export function JsonFile(id: string, content: any): Promise<JsonFile> {
  return File(id, {
    path: id,
    content: JSON.stringify(content, null, 2),
  });
}

export type TextFile = File;

export function TextFile(id: string, content: string): Promise<TextFile> {
  return File(id, {
    path: id,
    content,
  });
}

export type YamlFile = File;

export async function YamlFile(id: string, content: any): Promise<YamlFile> {
  const yaml = await import("yaml");
  return File(id, {
    path: id,
    content: yaml.stringify(content),
  });
}

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
