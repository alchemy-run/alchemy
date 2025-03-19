import fs from "node:fs";
import { unlink } from "node:fs/promises";
import path from "node:path";
import { ignore } from "./error";
import { Resource } from "./resource";

export class File extends Resource(
  "fs::File",
  async (ctx, filePath: string, content: string) => {
    if (ctx.event === "delete") {
      await ignore("ENOENT", () => fs.promises.unlink(filePath));
    } else {
      await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
      await fs.promises.writeFile(filePath, content);
    }
    return filePath;
  },
) {}

export class Folder extends Resource(
  "fs::Folder",
  async (ctx, dirPath: string): Promise<{ path: string }> => {
    if (ctx.event === "delete") {
      // we just do a best effort attempt
      await ignore(["ENOENT", "ENOTEMPTY"], () => fs.promises.rmdir(dirPath));
    } else {
      await ignore("EEXIST", () =>
        fs.promises.mkdir(dirPath, { recursive: true }),
      );
    }
    return { path: dirPath };
  },
) {
  public file(filePath: string, content: string) {
    return new File(path.basename(filePath), filePath, content);
  }
}

export async function rm(filePath: string) {
  try {
    await unlink(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }
}
