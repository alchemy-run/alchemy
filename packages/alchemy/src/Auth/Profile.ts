import * as Config from "effect/Config";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import os from "node:os";
import path from "pathe";
import type { AuthProvider, ConfigureContext } from "./AuthProvider.ts";

export const rootDir = path.join(os.homedir(), ".alchemy");
export const configFilePath = path.join(rootDir, "profiles.json");

/**
 * Config key consulted by the various `fromAuthProvider` /
 * `fromEnvironment` layers to pick which named profile in
 * `~/.alchemy/profiles.json` to use. Defaults to `"default"`.
 */
export const ALCHEMY_PROFILE = Config.string("ALCHEMY_PROFILE").pipe(
  Config.withDefault("default"),
);

export const CONFIG_VERSION = 0;

export class AlchemyConfig extends Context.Service<
  AlchemyConfig,
  {
    version: typeof CONFIG_VERSION;
    profiles: {
      [profileName: string]: AlchemyProfile;
    };
  }
>()("Alchemy::Profiles") {}

export interface AlchemyProfile {
  [providerName: string]: {
    /**
     * The method used to login to the provider. Different providers may use different methods, but common ones are:
     * - oauth: OAuth authentication
     * - api-key: API key authentication
     * - username-password: Username and password authentication
     * - token: Token authentication
     * - certificate: Certificate authentication
     * - ssh: SSH authentication
     * - other: Other authentication methods
     */
    method: string;
  };
}

const emptyConfig = (): AlchemyConfig["Service"] => ({
  version: CONFIG_VERSION,
  profiles: {},
});

export const readConfig = FileSystem.FileSystem.asEffect().pipe(
  Effect.flatMap((fs) => fs.readFileString(configFilePath)),
  Effect.flatMap((data) =>
    Effect.try({
      try: () => {
        const parsed = JSON.parse(data);
        if (parsed?.version !== CONFIG_VERSION) {
          // TODO(sam): this is destructive, should we maintain a chain of migrations from 0 to current?
          return emptyConfig();
        }
        return parsed as AlchemyConfig["Service"];
      },
      catch: emptyConfig,
    }),
  ),
  Effect.orElseSucceed(emptyConfig),
);

export const writeConfig = (config: AlchemyConfig["Service"]) =>
  FileSystem.FileSystem.asEffect().pipe(
    Effect.tap((fs) =>
      fs.makeDirectory(path.dirname(configFilePath), { recursive: true }),
    ),
    Effect.flatMap((fs) =>
      fs.writeFileString(configFilePath, JSON.stringify(config, null, 2)),
    ),
  );

export const getProfile = (name: string) =>
  readConfig.pipe(Effect.map((config) => config.profiles[name]));

export const setProfile = (name: string, profile: AlchemyProfile) =>
  readConfig.pipe(
    Effect.tap((config) =>
      Effect.sync(() => (config.profiles[name] = profile)),
    ),
    Effect.flatMap(writeConfig),
  );

/**
 * Remove `name` and all its provider credentials from the on-disk config.
 * Returns `true` if the profile existed and was removed, `false` otherwise.
 */
export const deleteProfile = (name: string) =>
  readConfig.pipe(
    Effect.flatMap((config) => {
      if (!(name in config.profiles)) {
        return Effect.succeed(false);
      }
      delete config.profiles[name];
      return writeConfig(config).pipe(Effect.as(true));
    }),
  );

/**
 * Returns a `ConfigProvider` that overrides `ALCHEMY_PROFILE` with the
 * given `profile` (when explicitly passed via the CLI `--profile` flag),
 * falling through to `base` for everything else.
 *
 * Use this to let the CLI's `--profile <name>` win over `$ALCHEMY_PROFILE`
 * without disturbing other config lookups.
 */
export const withProfileOverride = (
  base: ConfigProvider.ConfigProvider,
  profile: string | undefined,
): ConfigProvider.ConfigProvider => {
  if (profile === undefined) return base;
  const overrides: Record<string, string> = { ALCHEMY_PROFILE: profile };
  const overrideProvider = ConfigProvider.make((path) =>
    Effect.succeed(
      path.length === 1 && typeof path[0] === "string" && path[0] in overrides
        ? ConfigProvider.makeValue(overrides[path[0]]!)
        : undefined,
    ),
  );
  return ConfigProvider.orElse(base)(overrideProvider);
};

/**
 * Load the stored config for the given AuthProvider in `profileName`.
 * If absent, run the provider's `configure` step (passing through `ctx` so
 * providers can pick a CI-friendly default) and persist the resulting config
 * under the provider's name.
 */
export const loadOrConfigure = <Config extends { method: string }>(
  auth: AuthProvider<Config>,
  profileName: string,
  ctx: ConfigureContext,
) =>
  Effect.flatMap(getProfile(profileName), (existing) =>
    existing?.[auth.name]
      ? Effect.succeed(existing?.[auth.name])
      : Effect.tap(auth.configure(profileName, ctx), (config) =>
          setProfile(profileName, { ...existing, [auth.name]: config }),
        ),
  );
