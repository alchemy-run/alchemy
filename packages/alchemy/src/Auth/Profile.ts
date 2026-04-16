import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import type { PlatformError } from "effect/PlatformError";
import os from "node:os";
import path from "pathe";

export const rootDir = path.join(os.homedir(), ".alchemy");
export const configFilePath = path.join(rootDir, "profiles.json");

export const CONFIG_VERSION = 2;

export interface AlchemyProfiles {
  version: typeof CONFIG_VERSION;
  profiles: Record<string, AlchemyProfile>;
}

export type AlchemyProfile = Record<string, { method: string }>;

const emptyConfig = (): AlchemyProfiles => ({
  version: CONFIG_VERSION,
  profiles: {},
});

export const readConfig: Effect.Effect<
  AlchemyProfiles,
  never,
  FileSystem.FileSystem
> = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const data = yield* fs
    .readFileString(configFilePath)
    .pipe(Effect.orElseSucceed(() => undefined));
  if (data === undefined) return emptyConfig();
  try {
    const parsed = JSON.parse(data);
    if (parsed?.version !== CONFIG_VERSION) {
      return emptyConfig();
    }
    return parsed as AlchemyProfiles;
  } catch {
    return emptyConfig();
  }
});

export const writeConfig = (
  config: AlchemyProfiles,
): Effect.Effect<void, PlatformError, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    yield* fs.makeDirectory(path.dirname(configFilePath), {
      recursive: true,
    });
    yield* fs.writeFileString(configFilePath, JSON.stringify(config, null, 2));
  });

export const getProfile = (
  name: string,
): Effect.Effect<AlchemyProfile | undefined, never, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const config = yield* readConfig;
    return config.profiles[name];
  });

export const setProfile = (
  name: string,
  profile: AlchemyProfile,
): Effect.Effect<void, PlatformError, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const config = yield* readConfig;
    config.profiles[name] = profile;
    yield* writeConfig(config);
  });
