import fs from "node:fs/promises";
import path from "node:path";
import type { Scope } from "../scope";
import type { State, StateStore } from "../state";
import { ignore } from "../util/ignore";
import { deserialize, serialize } from "../util/serde";

const stateRootDir = path.join(process.cwd(), ".alchemy");

export class FileSystemStateStore implements StateStore {
  public readonly dir: string;
  constructor(public readonly scope: Scope) {
    this.dir = path.join(stateRootDir, ...scope.chain);
  }

  async init(): Promise<void> {
    await fs.mkdir(stateRootDir, { recursive: true });
    await fs.mkdir(this.dir, { recursive: true });
  }

  async deinit(): Promise<void> {
    await ignore("ENOENT", () => fs.rmdir(this.dir));
  }

  async count(): Promise<number> {
    return Object.keys(await this.list()).length;
  }

  async list(): Promise<string[]> {
    try {
      const files = await fs.readdir(this.dir, {
        withFileTypes: true,
      });
      return files
        .filter((dirent) => dirent.isFile() && dirent.name.endsWith(".json"))
        .map((dirent) => dirent.name.replace(/\.json$/, ""))
        .map((key) => key.replaceAll(":", "/"));
    } catch (error: any) {
      if (error.code === "ENOENT") {
        return [];
      }
      throw error;
    }
  }

  async get(key: string): Promise<State | undefined> {
    try {
      const content = await fs.readFile(await this.getPath(key), "utf8");
      const state = (await deserialize(
        this.scope,
        JSON.parse(content),
      )) as State;
      if (state.output === undefined) {
        state.output = {} as any;
      }
      state.output.Scope = this.scope;
      return state;
    } catch (error: any) {
      if (error.code === "ENOENT") {
        return undefined;
      }
      throw error;
    }
  }

  async set(key: string, value: State): Promise<void> {
    return fs.writeFile(
      await this.getPath(key),
      JSON.stringify(await serialize(this.scope, value), null, 2),
    );
  }

  async delete(key: string): Promise<void> {
    return fs.unlink(await this.getPath(key));
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
    if (key.includes(":")) {
      throw new Error(`ID cannot include colons: ${key}`);
    }
    if (key.includes("/")) {
      key = key.replaceAll("/", ":");
    }
    const file = path.join(this.dir, `${key}.json`);
    const dir = path.dirname(file);
    await fs.mkdir(dir, { recursive: true });
    return file;
  }
}
