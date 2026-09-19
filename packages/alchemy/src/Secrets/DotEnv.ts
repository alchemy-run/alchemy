import { ConfigError } from "effect/Config";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import { FileSystem } from "effect/FileSystem";
import { envKeys, logLoadedKeys } from "./Log.ts";

export interface DotEnvOptions {
  /**
   * File or ordered files to load. Later files override earlier files.
   * Every explicitly supplied path must exist; an empty array loads no files.
   * @default ".env"
   */
  path?: string | readonly string[];
  /**
   * Expand `${VAR}` references within the file.
   * @default false
   */
  expandVariables?: boolean;
}

const DEFAULT_PATH = ".env";

/** A provider that knows nothing — the starting point every file is stacked onto. */
const emptyProvider = ConfigProvider.fromEnv({ env: {} });

/** Normalise the `path` option into the ordered list of files to read. */
const filesToLoad = (options: DotEnvOptions): readonly string[] => {
  if (options.path === undefined) return [DEFAULT_PATH];
  if (typeof options.path === "string") return [options.path];
  return options.path;
};

const unableToLoad = (path: string) => (cause: unknown) =>
  new ConfigError(
    new ConfigProvider.SourceError({
      message: `Unable to load dotenv file ${path}`,
      cause,
    }),
  );

/**
 * Read a single dotenv file into a ConfigProvider.
 *
 * The implicit default `.env` is allowed to be absent and then contributes
 * nothing. A file the user named explicitly must exist, so any failure to read
 * or parse it surfaces as a ConfigError that names the offending file.
 */
const readDotEnvFile = (
  path: string,
  options: { readonly explicit: boolean; readonly expandVariables?: boolean },
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem;
    const missingDefault = !options.explicit && !(yield* fs.exists(path));
    if (missingDefault) {
      return emptyProvider;
    }
    return yield* ConfigProvider.fromDotEnv({
      path,
      expandVariables: options.expandVariables,
      preserveEmptyStrings: true,
    });
  }).pipe(Effect.mapError(unableToLoad(path)));

/**
 * Add dotenv files to Effect's ConfigProvider without touching `process.env`.
 *
 * Keys missing from every file fall back to the previous provider; an empty
 * value in a file is a real value and overrides it. With no explicit `path`,
 * a missing `.env` is silently ignored.
 *
 * Options may be an Effect so a stack can pick files by stage:
 *
 * ```ts
 * secrets: [
 *   Secrets.DotEnv(Effect.gen(function* () {
 *     const stage = yield* Stage;
 *     return { path: [".env", `.env.${stage}`] };
 *   })),
 * ]
 * ```
 */
export const DotEnv = <E = never, R = never>(
  options: DotEnvOptions | Effect.Effect<DotEnvOptions, E, R> = {},
) =>
  ConfigProvider.layerAdd(
    Effect.gen(function* () {
      const resolved = Effect.isEffect(options) ? yield* options : options;
      const explicit = resolved.path !== undefined;

      // Later files win, so each file is placed *in front of* everything
      // loaded before it.
      const paths = filesToLoad(resolved);
      let loaded = emptyProvider;
      for (const path of paths) {
        const file = yield* readDotEnvFile(path, {
          explicit,
          expandVariables: resolved.expandVariables,
        });
        loaded = ConfigProvider.orElse(file, loaded);
      }
      yield* logLoadedKeys(
        `dotenv (${paths.join(", ") || "no files"})`,
        yield* envKeys(loaded),
      );
      return loaded;
    }),
    { asPrimary: true },
  );
