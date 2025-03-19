import fs from "node:fs";
import path from "node:path";
import { ignore } from "./error";

export interface State {
  status:
    | `creating`
    | `created`
    | `updating`
    | `updated`
    | `deleting`
    | `deleted`;
  provider: string;
  data: Record<string, any>;
  deps: string[];
  inputs: any[];
  oldInputs?: any[];
  output: any;
}

export interface StateStore {
  /** Initialize the state container if one is required */
  init?(): Promise<void>;
  /** Delete the state container if one exists */
  deinit?(): Promise<void>;
  /** List all resources in the given stage. */
  list(): Promise<string[]>;
  /** Return the number of items let in this store */
  count(): Promise<number>;
  get(key: string): Promise<State | undefined>;
  getBatch(ids: string[]): Promise<Record<string, State>>;
  all(): Promise<Record<string, State>>;
  set(key: string, value: State): Promise<void>;
  delete(key: string): Promise<void>;
}

const stateFile = path.join(process.cwd(), ".alchemy");

export type StateStoreType = new (dir: string) => StateStore;

export class FileSystemStateStore implements StateStore {
  public readonly path: string;
  constructor(dir: string) {
    this.path = path.join(stateFile, dir);
  }

  async init(): Promise<void> {
    await fs.promises.mkdir(stateFile, { recursive: true });
    await fs.promises.mkdir(this.path, { recursive: true });
  }

  async deinit(): Promise<void> {
    await ignore("ENOENT", () => fs.promises.rmdir(this.path));
  }

  async count(): Promise<number> {
    return Object.keys(await this.list()).length;
  }

  async list(): Promise<string[]> {
    try {
      const files = await fs.promises.readdir(this.path, {
        withFileTypes: true,
      });
      return files
        .filter((dirent) => dirent.isFile() && dirent.name.endsWith(".json"))
        .map((dirent) => dirent.name.replace(/\.json$/, ""));
    } catch (error: any) {
      if (error.code === "ENOENT") {
        return [];
      }
      throw error;
    }
  }

  async get(key: string): Promise<State | undefined> {
    try {
      const content = await fs.promises.readFile(
        await this.getPath(key),
        "utf8",
      );
      return JSON.parse(content) as State;
    } catch (error: any) {
      if (error.code === "ENOENT") {
        return undefined;
      }
      throw error;
    }
  }

  async set(key: string, value: State): Promise<void> {
    return fs.promises.writeFile(
      await this.getPath(key),
      JSON.stringify(value, null, 2),
    );
  }

  async delete(key: string): Promise<void> {
    return fs.promises.unlink(await this.getPath(key));
  }

  async all(): Promise<Record<string, State>> {
    return this.getBatch(await this.list());
  }

  async getBatch(ids: string[]): Promise<Record<string, State>> {
    return Object.fromEntries(
      (
        await Promise.all(
          Array.from(ids).flatMap(async (id) => {
            const s = await this.get(id);
            if (s === undefined) {
              return [] as const;
            }
            return [[id, s]] as const;
          }),
        )
      ).flat(),
    );
  }

  private async getPath(key: string): Promise<string> {
    const file = path.join(this.path, `${key}.json`);
    const dir = path.dirname(file);
    await fs.promises.mkdir(dir, { recursive: true });
    return file;
  }
}
