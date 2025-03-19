import fs from "node:fs";
import path from "node:path";
import type { Provider, ResourceType } from "./resource";
import { FileSystemStateStore } from "./state";

export interface Config {
  defaultStage?: string;
  stateStore?: new (dir: string) => FileSystemStateStore;
}

const alchemy = path.resolve(process.cwd(), "alchemy.ts");

let _config: Config | undefined;

const exists =
  // @ts-ignore
  fs.promises.exists ??
  async function exists(path: string): Promise<boolean> {
    try {
      await fs.promises.access(path);
      return true;
    } catch {
      return false;
    }
  };

if (await exists(alchemy)) {
  const mod = await import(alchemy);
  if (mod) {
    const config = mod.default as Config | undefined;
    if (config) {
      if (typeof config !== "object") {
        throw new Error("Config is not an object");
      }
      if (typeof config.defaultStage !== "string") {
        throw new Error("Config.stage is not a string");
      }
      _config = config;
    }
  }
}

const _stage = process.env.ALCHEMY_STAGE ?? process.env.USER ?? "dev";

export const config: Config = _config ?? {
  defaultStage: _stage,
  stateStore: FileSystemStateStore,
};

export const defaultStage = config.defaultStage ?? _stage;

export const defaultStateStore = config.stateStore ?? FileSystemStateStore;

export const providers = new Map<
  ResourceType,
  Provider<ResourceType, any[], any>
>();

export const deletions: {
  id: string;
  data: Record<string, any>;
  inputs: any[];
}[] = [];
