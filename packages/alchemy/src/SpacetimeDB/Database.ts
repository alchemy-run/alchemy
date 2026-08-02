import { createHash } from "node:crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Redacted from "effect/Redacted";
import * as Stream from "effect/Stream";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import { isResolved } from "../Diff.ts";
import * as ProviderLayer from "../Local/ProviderLayer.ts";
import { createPhysicalName } from "../PhysicalName.ts";
import * as Provider from "../Provider.ts";
import { Resource } from "../Resource.ts";
import {
  decodeTokenIdentity,
  type DatabaseInfo,
  type SpacetimeDBClient as SpacetimeDBClientService,
  SpacetimeDBClient,
} from "./Client.ts";
import { SpacetimeDBCredentials } from "./Credentials.ts";
import {
  dashboardUrl,
  DEFAULT_HOST,
  normalizeHost,
  toWebSocketUri,
} from "./Host.ts";
import type { Providers } from "./Providers.ts";

export const DATABASE_NAME_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

export interface DatabaseProps {
  name?: string;
  modulePath?: string;
  binPath?: string;
  jsPath?: string;
  buildOptions?: string;
  clearData?: import("./Cli.ts").ClearDataMode;
  breakClients?: boolean;
  organization?: string;
  parent?: string;
  host?: string;
}

export type ModuleSource =
  | { kind: "modulePath"; path: string }
  | { kind: "binPath"; path: string }
  | { kind: "jsPath"; path: string };

export interface DatabaseAttributes {
  databaseIdentity: string;
  databaseName: string;
  host: string;
  uri: string;
  moduleHash: string;
  moduleContentHash: string;
  ownerIdentity: string;
  hostType: string;
  dashboardUrl: string | undefined;
  moduleSource: ModuleSource;
}

export type Database = Resource<
  "SpacetimeDB.Database",
  DatabaseProps,
  DatabaseAttributes,
  never,
  Providers
>;

/**
 * A SpacetimeDB database (module + data).
 *
 * `modulePath` (a server module project) or `binPath` / `jsPath` (a
 * pre-compiled module) are required. `alchemy deploy` publishes the
 * module to Maincloud (or the configured host); `alchemy dev` runs
 * `spacetime dev --server-only` for hot-reload local development.
 *
 * Databases default to **retain** on `alchemy destroy` so rows are not
 * irreversibly deleted. Opt in to deletion with `destroy()` from
 * `alchemy/RemovalPolicy`:
 *
 * ```typescript
 * import { destroy } from "alchemy/RemovalPolicy";
 *
 * yield* SpacetimeDB.Database("Game", {
 *   modulePath: "./spacetimedb",
 * }).pipe(destroy());
 * ```
 *
 * @resource
 * @see https://spacetimedb.com/docs/
 *
 * @section Publishing a TypeScript module
 * @example Publish a TS module to Maincloud
 * ```typescript
 * const game = yield* SpacetimeDB.Database("Game", {
 *   modulePath: "./spacetimedb",
 * });
 * ```
 *
 * @section Publishing a pre-compiled module
 * @example Publish a compiled WASM module
 * ```typescript
 * yield* SpacetimeDB.Database("Game", {
 *   binPath: "./build/game.wasm",
 * });
 * ```
 *
 * @section Wiring with other resources
 * The database's outputs flow into the typed bindings stack: pair with
 * {@link Generate} for typed client bindings, {@link Connect} to expose
 * uri/name/token to a Worker, and {@link viteEnv} to inline the
 * coordinates into a Vite SPA.
 *
 * @example Expose URI/identity to a Worker
 * ```typescript
 * const game = yield* SpacetimeDB.Database("Game", {
 *   modulePath: "./spacetimedb",
 * });
 *
 * const api = yield* Cloudflare.Worker("Api", {
 *   bindings: { SPACETIMEDB: game },
 * });
 * ```
 *
 * @example Inline URI/identity into a Vite SPA
 * ```typescript
 * yield* Cloudflare.Website.Vite("Web", {
 *   env: { ...SpacetimeDB.viteEnv(game), API: api.url },
 * });
 * ```
 *
 * @section Local development
 * @example Local dev with hot-reload
 * Under `alchemy dev`, the same resource runs in local mode: a
 * `spacetime dev --server-only` process hosts the database on
 * `127.0.0.1:3000`, watching `modulePath` for changes. Pass
 * `host: "local"` to make the intent explicit (it's the default during
 * dev).
 * ```typescript
 * yield* SpacetimeDB.Database("Game", {
 *   modulePath: "./spacetimedb",
 *   host: "local",
 * });
 * ```
 */
export const Database = Resource<Database>("SpacetimeDB.Database", {
  defaultRemovalPolicy: "retain",
});

export const resolveModuleSource = (
  news: DatabaseProps,
): ModuleSource | undefined => {
  if (news.modulePath) return { kind: "modulePath", path: news.modulePath };
  if (news.binPath) return { kind: "binPath", path: news.binPath };
  if (news.jsPath) return { kind: "jsPath", path: news.jsPath };
  return undefined;
};

const resolveEffectiveHost = (host: string | undefined) =>
  Effect.gen(function* () {
    if (host !== undefined) return yield* normalizeHost(host);
    const creds = yield* Effect.serviceOption(SpacetimeDBCredentials);
    if (Option.isSome(creds)) {
      const service = yield* creds.value;
      return service.host;
    }
    return DEFAULT_HOST;
  });

export const createDatabaseName = (id: string, name: string | undefined) =>
  Effect.gen(function* () {
    if (name !== undefined) return name;
    const generated = yield* createPhysicalName({
      id,
      lowercase: true,
      maxLength: 64,
      delimiter: "-",
    });
    return generated
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "");
  });

const readModuleBytes = (modulePath: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const resolved = path.isAbsolute(modulePath)
      ? modulePath
      : path.resolve(yield* Effect.sync(() => process.cwd()), modulePath);
    return yield* fs.readFile(resolved);
  });

const hashModuleBytes = (bytes: Uint8Array): string =>
  createHash("sha256").update(bytes).digest("hex");

export const hydrateAttributes = (
  client: SpacetimeDBClientService,
  nameOrIdentity: string,
  host: string,
  extras?: {
    databaseName?: string;
    moduleContentHash?: string;
    moduleSource?: ModuleSource;
  },
) =>
  Effect.gen(function* () {
    const info = yield* client.getDatabase(nameOrIdentity);
    const names = yield* client
      .getDatabaseNames(info.databaseIdentity)
      .pipe(
        Effect.catchTag("SpacetimeDBNotFound", () =>
          Effect.succeed([] as string[]),
        ),
      );
    const databaseName =
      extras?.databaseName && names.includes(extras.databaseName)
        ? extras.databaseName
        : (names[0] ?? extras?.databaseName ?? info.databaseIdentity);
    return {
      databaseIdentity: info.databaseIdentity,
      databaseName,
      host,
      uri: toWebSocketUri(host),
      moduleHash: info.initialProgram,
      moduleContentHash: extras?.moduleContentHash ?? "",
      ownerIdentity: info.ownerIdentity,
      hostType: info.hostType,
      dashboardUrl: dashboardUrl(databaseName, host),
      moduleSource: extras?.moduleSource ?? {
        kind: "binPath" as const,
        path: "",
      },
    } satisfies DatabaseAttributes;
  });

const setDatabaseName = (
  client: SpacetimeDBClientService,
  databaseIdentity: string,
  name: string,
) =>
  Effect.gen(function* () {
    const http = yield* HttpClient.HttpClient;
    const creds = client.credentials;
    const url = `${creds.host.replace(/\/+$/, "")}/v1/database/${encodeURIComponent(databaseIdentity)}/names`;
    const request = HttpClientRequest.post(url).pipe(
      HttpClientRequest.bearerToken(Redacted.value(creds.token)),
      HttpClientRequest.bodyText(name, "text/plain"),
    );
    const response = yield* http
      .execute(request)
      .pipe(
        Effect.mapError(
          (cause) =>
            new Error(
              `Failed to set SpacetimeDB database name '${name}' on ${databaseIdentity}: ${String(cause)}`,
            ),
        ),
      );
    if (response.status < 200 || response.status >= 300) {
      const body = yield* response.text.pipe(Effect.orElseSucceed(() => ""));
      return yield* Effect.fail(
        new Error(
          `Failed to set SpacetimeDB database name '${name}' on ${databaseIdentity}: HTTP ${response.status} ${body}`,
        ),
      );
    }
  });

/** Parse SpacetimeDB log text into Alchemy {@link Provider.LogLine}s. */
export const parseLogLines = (
  text: string,
): Array<{ timestamp: Date; message: string }> => {
  const lines = text.split(/\r?\n/).filter((l) => l.length > 0);
  return lines.map((line) => {
    const match = line.match(/^(\d{4}-\d{2}-\d{2}T[^\s]+)\s+(.*)$/);
    if (match) {
      const ts = new Date(match[1]!);
      return {
        timestamp: Number.isNaN(ts.getTime()) ? new Date() : ts,
        message: match[2] ?? line,
      };
    }
    return { timestamp: new Date(), message: line };
  });
};

export const DatabaseProviderLive = () =>
  Provider.succeed(Database, {
    stables: ["databaseIdentity"],
    list: Effect.fn(function* () {
      const client = yield* SpacetimeDBClient;
      const creds = yield* yield* SpacetimeDBCredentials;
      const ownerIdentity = yield* decodeTokenIdentity(
        Redacted.value(creds.token),
      );
      const identities = yield* client.listDatabaseIdentities(ownerIdentity);
      const rows = yield* Effect.forEach(
        identities,
        (identity) =>
          hydrateAttributes(client, identity, creds.host).pipe(
            Effect.catchTag("SpacetimeDBNotFound", () =>
              Effect.succeed(undefined),
            ),
          ),
        { concurrency: 10 },
      );
      return rows.filter((row): row is DatabaseAttributes => row !== undefined);
    }),
    diff: Effect.fn(function* ({ id, news = {}, olds = {}, output }) {
      if (!isResolved(news)) return undefined;
      const oldHost = output?.host ?? (yield* resolveEffectiveHost(olds.host));
      const newHost = yield* resolveEffectiveHost(news.host);
      if (oldHost !== newHost) return { action: "replace" } as const;
      const oldName =
        output?.databaseName ?? (yield* createDatabaseName(id, olds.name));
      if (news.name !== undefined && news.name !== oldName) {
        return { action: "update" } as const;
      }
      if (
        news.clearData !== olds.clearData ||
        news.breakClients !== olds.breakClients
      ) {
        return { action: "update" } as const;
      }
      const modulePath = news.binPath ?? news.jsPath;
      if (modulePath) {
        const bytes = yield* readModuleBytes(modulePath).pipe(
          Effect.catch(() => Effect.succeed(new Uint8Array())),
        );
        const hash = hashModuleBytes(bytes);
        if (hash !== output?.moduleContentHash) {
          return { action: "update" } as const;
        }
      }
      if (news.modulePath) {
        return { action: "update" } as const;
      }
      return undefined;
    }),
    read: Effect.fn(function* ({ id, output, olds }) {
      const client = yield* SpacetimeDBClient;
      const host = yield* resolveEffectiveHost(olds?.host ?? output?.host);
      if (output?.databaseIdentity) {
        return yield* hydrateAttributes(client, output.databaseIdentity, host, {
          databaseName: output.databaseName,
          moduleContentHash: output.moduleContentHash,
          moduleSource: output.moduleSource,
        }).pipe(
          Effect.catchTag("SpacetimeDBNotFound", () =>
            Effect.succeed(undefined),
          ),
        );
      }
      const name = yield* createDatabaseName(id, olds?.name);
      return yield* hydrateAttributes(client, name, host, {
        databaseName: name,
        moduleContentHash: output?.moduleContentHash ?? "",
        moduleSource: output?.moduleSource,
      }).pipe(
        Effect.catchTag("SpacetimeDBNotFound", () => Effect.succeed(undefined)),
      );
    }),
    reconcile: Effect.fn(function* ({ id, news = {}, output }) {
      const client = yield* SpacetimeDBClient;
      const host = yield* resolveEffectiveHost(news.host);
      const modulePath = news.binPath ?? news.jsPath;
      if (!modulePath) {
        return yield* Effect.die(
          new Error(
            "SpacetimeDB.Database requires one of `modulePath`, `binPath`, or `jsPath`",
          ),
        );
      }
      const moduleBytes = yield* readModuleBytes(modulePath);
      const moduleContentHash = hashModuleBytes(moduleBytes);
      const moduleSource = resolveModuleSource(news)!;
      const desiredName =
        news.name ??
        output?.databaseName ??
        (yield* createDatabaseName(id, news.name));
      if (!DATABASE_NAME_RE.test(desiredName)) {
        return yield* Effect.die(
          new Error(
            `Invalid SpacetimeDB database name '${desiredName}'. Names must match /^[a-z0-9]+(-[a-z0-9]+)*$/.`,
          ),
        );
      }
      let observed: DatabaseInfo | undefined;
      if (output?.databaseIdentity) {
        observed = yield* client
          .getDatabase(output.databaseIdentity)
          .pipe(
            Effect.catchTag("SpacetimeDBNotFound", () =>
              Effect.succeed(undefined),
            ),
          );
      }
      if (observed === undefined) {
        observed = yield* client
          .getDatabase(desiredName)
          .pipe(
            Effect.catchTag("SpacetimeDBNotFound", () =>
              Effect.succeed(undefined),
            ),
          );
      }
      const publishTarget = observed?.databaseIdentity ?? desiredName;
      const published = yield* client.publish(publishTarget, moduleBytes, {
        clear: news.clearData === true || news.clearData === "always",
      });
      if (observed) {
        const names = yield* client.getDatabaseNames(
          published.databaseIdentity,
        );
        if (!names.includes(desiredName)) {
          yield* setDatabaseName(
            client,
            published.databaseIdentity,
            desiredName,
          );
        }
      }
      const live = yield* client.getDatabase(published.databaseIdentity);
      const names = yield* client.getDatabaseNames(published.databaseIdentity);
      const databaseName =
        names.find((n) => n === desiredName) ?? names[0] ?? desiredName;
      return {
        databaseIdentity: live.databaseIdentity,
        databaseName,
        host,
        uri: toWebSocketUri(host),
        moduleHash: live.initialProgram,
        moduleContentHash,
        ownerIdentity: live.ownerIdentity,
        hostType: live.hostType,
        dashboardUrl: dashboardUrl(databaseName, host),
        moduleSource,
      } satisfies DatabaseAttributes;
    }),
    delete: Effect.fn(function* ({ output }) {
      const target = output.databaseIdentity || output.databaseName;
      const client = yield* SpacetimeDBClient;
      yield* client
        .deleteDatabase(target)
        .pipe(Effect.catchTag("SpacetimeDBNotFound", () => Effect.void));
    }),
    logs: Effect.fn(function* ({ output, options }) {
      const client = yield* SpacetimeDBClient;
      const target = output.databaseIdentity || output.databaseName;
      const text = yield* client.getLogs(target, {
        numLines: options.limit ?? 100,
      });
      return parseLogLines(text);
    }),
    tail: ({ output }) =>
      Stream.unwrap(
        Effect.gen(function* () {
          const client = yield* SpacetimeDBClient;
          const target = output.databaseIdentity || output.databaseName;
          let cursor: { timestamp: Date; message: string } | undefined;
          const poll = Stream.tick("2 seconds").pipe(
            Stream.mapEffect(() =>
              client.getLogs(target, { numLines: 200 }).pipe(
                Effect.map((text) => {
                  const lines = parseLogLines(text);
                  const fresh =
                    cursor === undefined
                      ? lines
                      : lines.filter(
                          (l) =>
                            l.timestamp.getTime() >
                              cursor!.timestamp.getTime() ||
                            (l.timestamp.getTime() ===
                              cursor!.timestamp.getTime() &&
                              l.message !== cursor!.message),
                        );
                  const last = fresh.at(-1);
                  if (last) cursor = last;
                  return fresh;
                }),
              ),
            ),
            Stream.flatMap((lines) => Stream.fromIterable(lines)),
          );
          const followed = client.streamLogs(target).pipe(
            Stream.flatMap((chunk) =>
              Stream.fromIterable(parseLogLines(chunk)),
            ),
            Stream.concat(poll),
            Stream.catchCause(() => poll),
          );
          return followed;
        }),
      ),
  });

export const DatabaseProvider = () =>
  ProviderLayer.dual(Database, {
    live: () => DatabaseProviderLive(),
    local: () =>
      Layer.unwrap(
        Effect.promise(() =>
          import("./LocalDatabase.ts").then((m) => m.DatabaseProviderLocal()),
        ),
      ),
  });
