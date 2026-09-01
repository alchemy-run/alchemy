import * as Config from "effect/Config";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import {
  AuthError,
  getAuthProvider,
  presentEnvironment,
} from "./AuthProvider.ts";
import {
  ALCHEMY_PROFILE,
  DEFAULT_PROFILE_NAME,
  ProfileError,
  ProfileStore,
  SuppressMissingProviderConfig,
} from "./Profile.ts";
import { loadConfigProvider } from "../Util/ConfigProvider.ts";

/**
 * Resolve the selected Alchemy profile after the command's dotenv provider is
 * known. An omitted explicit override remains absent so it does not shadow
 * `ALCHEMY_PROFILE` from `.env` / `--env-file`.
 */
export const resolveProfileSelection = Effect.fn(function* (
  envFile: Option.Option<string>,
  override: string | undefined,
) {
  const base = yield* loadConfigProvider(envFile);
  const profiles = yield* ProfileStore;
  const selected = yield* profiles.current.pipe(
    Effect.provideService(
      ConfigProvider.ConfigProvider,
      withProfileOverride(base, override),
    ),
  );
  return {
    ...selected,
    source:
      override === undefined ? selected.source : ("command-line" as const),
  };
});

export const resolveProfileName = Effect.fn(function* (
  envFile: Option.Option<string>,
  override: string | undefined,
) {
  return (yield* resolveProfileSelection(envFile, override)).name;
});

/**
 * The shared preamble of every per-cloud `fromAuthProvider` /
 * `fromEnvironment` layer. Precedence remains CI environment, explicitly
 * exported local environment credentials, then the selected profile.
 */
export const resolveProviderConfig = <
  C extends { method: string } = any,
  Credentials = any,
>(
  providerName: string,
) =>
  Effect.gen(function* () {
    const auth = yield* getAuthProvider<C, Credentials>(providerName);
    const ci = yield* Config.boolean("CI").pipe(Config.withDefault(false));
    // Explicit profile selection is authoritative — even under CI=true.
    // (The alchemy-test runner defaults CI to "true", and PR #1234's
    // contract is that an explicitly selected profile wins; only an
    // IMPLICIT profile is unavailable in CI.)
    const explicitProfile = yield* Config.option(ALCHEMY_PROFILE).pipe(
      Effect.mapError(
        (cause) =>
          new ProfileError({
            message: "Could not resolve ALCHEMY_PROFILE.",
            cause,
          }),
      ),
    );
    if (ci && Option.isNone(explicitProfile)) {
      if (auth.readEnvironment === undefined) {
        return yield* Effect.fail(
          new AuthError({
            message: `Auth provider '${providerName}' does not support environment credentials in CI.`,
          }),
        );
      }
      return {
        auth,
        profileName: undefined,
        config: undefined,
        resolve: auth.readEnvironment,
        source: "environment" as const,
      };
    }
    const profile = yield* ProfileStore;
    const configuredProfile = explicitProfile;
    if (
      Option.isNone(configuredProfile) &&
      auth.readEnvironment !== undefined
    ) {
      const used = yield* Effect.sync(() =>
        presentEnvironment(auth.environment, process.env),
      );
      if (used !== undefined) {
        yield* warnEnvironmentCredentials(providerName, used);
        return {
          auth,
          profileName: undefined,
          config: undefined,
          resolve: auth.readEnvironment,
          source: "environment" as const,
        };
      }
    }
    const selection = yield* profile.current;
    const profileName = selection.name;
    const config = yield* profile.loadProviderConfig(auth, profileName);
    return {
      auth,
      profileName,
      config,
      resolve: auth.read(profileName, config),
      source: "profile" as const,
    };
  });

const warnEnvironmentCredentials = (
  provider: string,
  used: ReadonlyArray<string>,
) =>
  Effect.gen(function* () {
    if (yield* SuppressMissingProviderConfig) return;
    yield* Console.warn(
      `${provider}: using credentials from environment variables (${used.join(", ")}) — ` +
        `the '${DEFAULT_PROFILE_NAME}' profile was not used. Pass --profile <name> (or unset ` +
        "the variables) to use stored profile credentials.",
    );
  });

/** Let an explicit profile override configured selection without disturbing other keys. */
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
