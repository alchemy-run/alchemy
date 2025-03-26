import fs from "node:fs";
import { unlink } from "node:fs/promises";
import path from "node:path";
import type { Context } from "./context";
import { ignore } from "./error";
import { Resource } from "./resource";

export interface File extends Resource<"fs::File"> {
  path: string;
  content: string;
}

export const File = Resource(
  "fs::File",
  async function (
    this: Context<File>,
    id: string,
    {
      path: filePath,
      content,
    }: {
      path: string;
      content: string;
    },
  ): Promise<File> {
    if (this.phase === "delete") {
      await ignore("ENOENT", async () => fs.promises.unlink(filePath));
      return this.destroy();
    } else {
      await fs.promises.mkdir(path.dirname(filePath), {
        recursive: true,
      });
      await fs.promises.writeFile(filePath, content);
    }
    return this({
      path: filePath,
      content,
    });
  },
);

export interface Folder extends Resource<"fs::Folder"> {
  path: string;
}

export const Folder = Resource(
  "fs::Folder",
  async function (
    this: Context<Folder>,
    id: string,
    { path: dirPath }: { path: string },
  ): Promise<Folder> {
    if (this.phase === "delete") {
      // we just do a best effort attempt
      await ignore(["ENOENT", "ENOTEMPTY"], async () =>
        fs.promises.rmdir(dirPath),
      );
      return this.destroy();
    } else {
      await ignore("EEXIST", async () =>
        fs.promises.mkdir(dirPath, { recursive: true }),
      );
    }
    return this({
      path: dirPath,
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
