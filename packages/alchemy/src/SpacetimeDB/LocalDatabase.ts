import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import { isResolved } from "../Diff.ts";
import {
  CommandExecutor,
  makeCommandError,
  UnexpectedExit,
} from "../Command/Command.ts";
import * as LocalProvider from "../Local/LocalProvider.ts";
import { hashModuleSource, localDevArgs, scrapeIdentity } from "./Cli.ts";
import {
  createDatabaseName,
  DATABASE_NAME_RE,
  Database,
  type DatabaseAttributes,
  resolveModuleSource,
} from "./Database.ts";
import { dashboardUrl, normalizeHost, toWebSocketUri } from "./Host.ts";

const LOCAL_DEFAULT_HOST = "http://127.0.0.1:3000";

interface LocalDatabaseConfig {
  name: string;
  modulePath: string | undefined;
  binPath: string | undefined;
  jsPath: string | undefined;
  clearData: import("./Cli.ts").ClearDataMode;
  breakClients: boolean;
  host: string;
  buildOptions: string | undefined;
  moduleContentHash: string;
}

/**
 * Local (`alchemy dev`) Database provider.
 *
 * Spawns `spacetime dev <name> --server-only`, which:
 * 1. Starts a local SpacetimeDB server if needed
 * 2. Builds + publishes the module
 * 3. Watches `modulePath` and hot-reloads on save
 *
 * Requires the `spacetime` CLI on `PATH`.
 *
 * @see https://spacetimedb.com/docs/databases/developing
 */
export const DatabaseProviderLocal = () =>
  LocalProvider.make(
    Database,
    import.meta.resolve(
      import.meta.url.endsWith(".ts") ? "./Local.ts" : "./Local.js",
      import.meta.url,
    ),
    Effect.gen(function* () {
      const { spawn } = yield* CommandExecutor;
      const http = yield* HttpClient.HttpClient;

      return {
        resolveConfig: ({ news, id }) => {
          if (!isResolved(news)) {
            return Effect.gen(function* () {
              const databaseName = yield* createDatabaseName(id, undefined);
              const moduleHash = yield* hashModuleSource(
                undefined,
                undefined,
                undefined,
                undefined,
              );
              return {
                name: databaseName,
                modulePath: undefined,
                binPath: undefined,
                jsPath: undefined,
                clearData: false,
                breakClients: false,
                host: "local",
                buildOptions: undefined,
                moduleContentHash: moduleHash,
              } satisfies LocalDatabaseConfig;
            });
          }
          return Effect.gen(function* () {
            const databaseName = yield* createDatabaseName(id, news.name);
            const moduleHash = yield* hashModuleSource(
              news.modulePath,
              news.binPath,
              news.jsPath,
              undefined,
            );
            return {
              name: databaseName,
              modulePath: news.modulePath,
              binPath: news.binPath,
              jsPath: news.jsPath,
              clearData: news.clearData ?? false,
              breakClients: news.breakClients ?? false,
              host: news.host ?? "local",
              buildOptions: news.buildOptions,
              moduleContentHash: moduleHash,
            } satisfies LocalDatabaseConfig;
          });
        },

        start: (ctx) =>
          Effect.gen(function* () {
            const { config, news, invalidate } = ctx;
            if (!isResolved(news)) {
              return yield* Effect.die(
                new Error(
                  "SpacetimeDB.Database (local) news must be resolved before start",
                ),
              );
            }
            const source = resolveModuleSource(news);
            if (!source) {
              return yield* Effect.die(
                new Error(
                  "SpacetimeDB.Database (local) requires one of `modulePath`, `binPath`, or `jsPath`",
                ),
              );
            }

            // Re-validate here (resolveConfig only sees isResolved(news) once).
            if (!DATABASE_NAME_RE.test(config.name)) {
              return yield* Effect.die(
                new Error(
                  `Invalid SpacetimeDB database name '${config.name}'. Names must match /^[a-z0-9]+(-[a-z0-9]+)*$/.`,
                ),
              );
            }

            const databaseName = config.name;
            const host = yield* normalizeHost(config.host);
            const args = localDevArgs({
              database: databaseName,
              modulePath: news.modulePath,
              binPath: news.binPath,
              jsPath: news.jsPath,
              clearData: news.clearData,
              host: news.host ?? "local",
            });

            const command = `spacetime ${args.map(shellQuote).join(" ")}`;
            const props = { command, shell: true as const };
            const child = yield* spawn(props);

            let buffer = "";

            const mirror = (sink: "stdout" | "stderr") =>
              child[sink].pipe(
                Stream.decodeText,
                Stream.tap((text) =>
                  Effect.sync(() => {
                    process[sink].write(text);
                    buffer += text;
                  }),
                ),
                Stream.runDrain,
                Effect.forkScoped,
              );

            yield* mirror("stdout");
            yield* mirror("stderr");

            // Readiness: poll /v1/ping until the local server answers, or the
            // process exits first. 2xx-only — a stray server on :3000 would
            // otherwise be falsely treated as ready.
            const pingHost = host.includes("://") ? host : LOCAL_DEFAULT_HOST;

            const waitReady = http
              .execute(
                HttpClientRequest.get(
                  `${pingHost.replace(/\/+$/, "")}/v1/ping`,
                ),
              )
              .pipe(
                Effect.flatMap((res) =>
                  res.status >= 200 && res.status < 300
                    ? Effect.void
                    : Effect.fail(new Error(`ping ${res.status}`)),
                ),
                Effect.retry({
                  times: 60,
                  schedule: Schedule.spaced(Duration.millis(500)),
                }),
              );

            yield* Effect.raceAllFirst([
              waitReady,
              child.exitCode.pipe(
                Effect.mapError((error) =>
                  makeCommandError(props, error.reason),
                ),
                Effect.flatMap((exitCode) =>
                  Effect.fail(
                    makeCommandError(
                      props,
                      new UnexpectedExit({ exitCode, stderr: buffer }),
                    ),
                  ),
                ),
              ),
            ]);

            const identity = scrapeIdentity(buffer) ?? databaseName;

            yield* child.exitCode.pipe(
              Effect.exit,
              Effect.flatMap(() => invalidate),
              Effect.forkScoped,
            );

            return {
              databaseIdentity: identity ?? databaseName,
              databaseName,
              host: pingHost,
              uri: toWebSocketUri(pingHost),
              moduleHash: "",
              moduleContentHash: "",
              ownerIdentity: "",
              hostType: "wasm",
              dashboardUrl: dashboardUrl(databaseName, pingHost),
              moduleSource: source,
            } satisfies DatabaseAttributes;
          }),
      } satisfies LocalProvider.LocalProviderSpec<
        Database,
        LocalDatabaseConfig
      >;
    }),
  );

const shellQuote = (value: string) => {
  if (value.length === 0) return "''";
  if (/^[a-zA-Z0-9_./:=+-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, `'\\''`)}'`;
};

export { shellQuote };
