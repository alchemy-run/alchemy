import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import type { PlatformError } from "effect/PlatformError";
import os from "node:os";
import nodePath from "node:path";
import type { AwsAuthConfig } from "./AWS/AuthProvider.ts";
import type { CloudflareAuthConfig } from "./Cloudflare/AuthProvider.ts";

export const rootDir = nodePath.join(os.homedir(), ".alchemy");
export const configFilePath = nodePath.join(rootDir, "config.json");

export const CONFIG_VERSION = 2;

export interface AlchemyConfig {
  version: typeof CONFIG_VERSION;
  profiles: Record<string, AlchemyProfile>;
}

export interface AlchemyProfile {
  aws?: AwsAuthConfig;
  cloudflare?: CloudflareAuthConfig;
}

const emptyConfig = (): AlchemyConfig => ({
  version: CONFIG_VERSION,
  profiles: {},
});

export const readConfig: Effect.Effect<
  AlchemyConfig,
  never,
  FileSystem.FileSystem
> = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const data = yield* fs
    .readFileString(configFilePath)
    .pipe(Effect.catch(() => Effect.succeed(undefined)));
  if (data === undefined) return emptyConfig();
  try {
    const parsed = JSON.parse(data);
    if (parsed?.version !== CONFIG_VERSION) {
      return emptyConfig();
    }
    return parsed as AlchemyConfig;
  } catch {
    return emptyConfig();
  }
});

export const writeConfig = (
  config: AlchemyConfig,
): Effect.Effect<void, PlatformError, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    yield* fs.makeDirectory(nodePath.dirname(configFilePath), {
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
