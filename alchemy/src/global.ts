import type { Provider, ResourceType } from "./resource";
import { FileSystemStateStore } from "./state";

export const DEFAULT_STAGE =
  process.env.ALCHEMY_STAGE ?? process.env.USER ?? "dev";

export const DEFAULT_STATE_STORE_TYPE = FileSystemStateStore;

export const PROVIDERS = new Map<ResourceType, Provider<any, any>>();
