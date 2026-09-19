import * as Config from "effect/Config";
import { ConfigError } from "effect/Config";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { DotEnv } from "../Secrets/DotEnv.ts";
import type { StackSecrets, StackServices } from "../Stack.ts";

/**
 * The real process environment. Empty strings are kept as explicit values.
 * `fromEnv` snapshots `process.env` when called, so build it fresh each time
 * rather than once at module load.
 */
const processEnvironment = () =>
  ConfigProvider.fromEnv({ preserveEmptyStrings: true });

/** A provider that knows nothing. */
const emptyProvider = ConfigProvider.fromEnv({ env: {} });

/**
 * Settings that came from the command line and therefore must outrank
 * anything a stack's `secrets` layers load.
 *
 * @internal
 */
export interface StackConfigOverrides {
  /**
   * The `--env-file` flag. Also the file the implicit `DotEnv()` layer reads
   * when a stack declares no `secrets`.
   */
  readonly envFile?: string;
  /**
   * Re-applied on top of every intermediate provider so that e.g. `--profile`
   * keeps winning no matter what a secrets layer returns.
   */
  readonly apply: (
    provider: ConfigProvider.ConfigProvider,
  ) => ConfigProvider.ConfigProvider;
}

/** @internal */
export const StackConfigOverrides = Context.Reference<StackConfigOverrides>(
  "Alchemy/StackConfigOverrides",
  { defaultValue: () => ({ apply: (provider) => provider }) },
);

/**
 * Build the ConfigProvider a stack runs under from its `secrets` providers,
 * then check the result against the stack's secrets schema.
 *
 * Precedence, highest first: CLI overrides, the process environment, the last
 * provider, ..., the first provider.
 *
 * Each provider is built with the configuration assembled so far, so an
 * options effect can read the `Stage` or values loaded by an earlier one.
 * When the stack declares no providers, a single `DotEnv()` reading `.env`
 * (or the `--env-file`) is used.
 *
 * @internal
 */
export const stackConfigLayer = (
  secrets?: StackSecrets,
): Layer.Layer<never, ConfigError, StackServices> =>
  Layer.effect(
    ConfigProvider.ConfigProvider,
    Effect.gen(function* () {
      const overrides = yield* StackConfigOverrides;
      const sources = secrets?.providers ?? [
        DotEnv({ path: overrides.envFile }),
      ];

      const withPrecedence = (fromSecrets: ConfigProvider.ConfigProvider) =>
        overrides.apply(
          secrets?.automaticallyLoadProcessEnv === false
            ? fromSecrets
            : ConfigProvider.orElse(processEnvironment(), fromSecrets),
        );

      let fromSecrets = emptyProvider;
      for (const source of sources) {
        // A stack fails with ConfigError only; a secrets source that fails
        // for its own reasons (auth, network) is reported as one, keeping
        // the source's message.
        const built = yield* Layer.build(source).pipe(
          Effect.provideService(
            ConfigProvider.ConfigProvider,
            withPrecedence(fromSecrets),
          ),
          Effect.mapError((error) =>
            error instanceof ConfigError
              ? error
              : new ConfigError(
                  new ConfigProvider.SourceError({
                    message:
                      error instanceof Error ? error.message : String(error),
                    cause: error,
                  }),
                ),
          ),
        );
        const provider = Context.get(built, ConfigProvider.ConfigProvider);
        fromSecrets = ConfigProvider.orElse(provider, fromSecrets);
      }

      const assembled = withPrecedence(fromSecrets);
      if (secrets?.schema !== undefined) {
        yield* Config.schema(secrets.schema).parse(assembled);
        yield* Effect.logDebug("Stack secrets satisfy the declared schema");
      }
      return assembled;
    }),
  );

/**
 * The ConfigProvider a CLI command runs under before any stack is loaded:
 * the process environment on top of the `--env-file` (which must exist) or,
 * failing that, an optional `.env` in the working directory.
 */
export const loadConfigProvider = (envFile: Option.Option<string>) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;

    let path: string | undefined;
    if (Option.isSome(envFile)) {
      path = envFile.value;
    } else if (yield* fs.exists(".env")) {
      path = ".env";
    }

    if (path === undefined) {
      return processEnvironment();
    }
    const dotEnv = yield* ConfigProvider.fromDotEnv({
      path,
      preserveEmptyStrings: true,
    });
    return ConfigProvider.orElse(processEnvironment(), dotEnv);
  });
