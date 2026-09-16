import * as Effect from "effect/Effect";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { localStorageDirectory } from "../LocalRuntime.ts";

/** Internal persistent local Flagship control-plane store. */
export const makeLocalStore = (directory: string) => {
  const root = path.join(directory, "flagship");
  const file = (appId: string, key?: string) =>
    key === undefined
      ? path.join(root, encodeURIComponent(appId), "app.json")
      : path.join(
          root,
          encodeURIComponent(appId),
          "flags",
          `${encodeURIComponent(key)}.json`,
        );
  return {
    read: <T>(appId: string, key?: string) =>
      Effect.promise(async (): Promise<T | undefined> => {
        try {
          return JSON.parse(await fs.readFile(file(appId, key), "utf8"));
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT")
            return undefined;
          throw error;
        }
      }),
    write: <T>(appId: string, value: T, key?: string) =>
      Effect.promise(async () => {
        const filename = file(appId, key);
        await fs.mkdir(path.dirname(filename), { recursive: true });
        const temporary = `${filename}.${crypto.randomUUID()}.tmp`;
        await fs.writeFile(temporary, JSON.stringify(value));
        await fs.rename(temporary, filename);
        return value;
      }),
    remove: (appId: string, key?: string) =>
      Effect.promise(() =>
        fs.rm(
          key === undefined ? path.dirname(file(appId)) : file(appId, key),
          { recursive: key === undefined, force: true },
        ),
      ),
  };
};

export const localStore = Effect.map(localStorageDirectory, makeLocalStore);
