import fs from "node:fs";
import { unlink } from "node:fs/promises";
import path from "node:path";
import { ignore } from "./error";
import type { Input } from "./input";
import { output } from "./output";
import { type Context, Resource } from "./resource";

export const File = Resource(
  "fs::File",
  async function (
    this: Context<string> | void,
    id: string,
    props: Input<{
      path: string;
      content: string;
    }>,
  ) {
    return output(id, async () => {
      if (this!.event === "delete") {
        await ignore("ENOENT", async () =>
          fs.promises.unlink(await props.path),
        );
      } else {
        await fs.promises.mkdir(path.dirname(await props.path), {
          recursive: true,
        });
        await fs.promises.writeFile(await props.path, await props.content);
      }
      return props.path;
    });
  },
);

export const Folder = Resource(
  "fs::Folder",
  async function (
    this: Context<string> | void,
    id: string,
    dirPath: Input<string>,
  ): Promise<{ path: string }> {
    return output(id, async () => {
      if (this!.event === "delete") {
        // we just do a best effort attempt
        await ignore(["ENOENT", "ENOTEMPTY"], async () =>
          fs.promises.rmdir(await dirPath),
        );
      } else {
        await ignore("EEXIST", async () =>
          fs.promises.mkdir(await dirPath, { recursive: true }),
        );
      }
      return { path: await dirPath };
    });
  },
);

export async function rm(filePath: string) {
  try {
    await unlink(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }
}
