import * as hyperdrive from "@distilled.cloud/cloudflare/hyperdrive";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";

import { AlchemyContext } from "../../AlchemyContext.ts";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { CloudflareEnvironment } from "../CloudflareEnvironment.ts";
import type { Providers } from "../Providers.ts";
import { HyperdriveConnection } from "./HyperdriveConnection.ts";

export type HyperdriveScheme = "postgres" | "postgresql" | "mysql";

/**
 * Origin configuration for a public PostgreSQL or MySQL database.
 */
export type HyperdrivePublicOrigin = {
  scheme: HyperdriveScheme;
  host: string;
  port?: number;
  database: string;
  user: string;
  /**
   * Database password. Pass a plain string or a `Redacted<string>` to keep it
   * out of logs.
   */
  password: Redacted.Redacted<string>;
};

/**
 * Origin configuration for a database fronted by Cloudflare Access.
 */
export type HyperdriveAccessOrigin = {
  scheme: HyperdriveScheme;
  host: string;
  database: string;
  user: string;
  password: Redacted.Redacted<string>;
  accessClientId: Redacted.Redacted<string>;
  accessClientSecret: Redacted.Redacted<string>;
};

export type HyperdriveOrigin = HyperdrivePublicOrigin | HyperdriveAccessOrigin;

export type HyperdriveCaching = {
  /**
   * Whether caching is disabled.
   * @default false
   */
  disabled?: boolean;
  /**
   * Maximum duration items should persist in the cache, in seconds.
   * @default 60
   */
  maxAge?: number;
  /**
   * Number of seconds the cache may serve a stale response while revalidating.
   * @default 15
   */
  staleWhileRevalidate?: number;
};

export type HyperdriveMtls = {
  caCertificateId?: string;
  mtlsCertificateId?: string;
  /**
   * @default "verify-full"
   */
  sslmode?: string;
};

export type HyperdriveProps = {
  /**
   * Name of the Hyperdrive configuration. If omitted, a unique name will be
   * generated.
   * @default ${app}-${stage}-${id}
   */
  name?: string;
  /**
   * Database connection origin. Hyperdrive supports public Postgres/MySQL
   * databases and databases fronted by Cloudflare Access.
   */
  origin: HyperdriveOrigin;
  /**
   * Caching configuration.
   */
  caching?: HyperdriveCaching;
  /**
   * mTLS configuration.
   */
  mtls?: HyperdriveMtls;
  /**
   * The (soft) maximum number of connections Hyperdrive is allowed to make to
   * the origin database.
   */
  originConnectionLimit?: number;
  /**
   * Local development overrides. When the stack runs in dev mode
   * connect to a locally running database
   */
  dev?: HyperdrivePublicOrigin;
};

export type Hyperdrive = Resource<
  "Cloudflare.Hyperdrive",
  HyperdriveProps,
  {
    hyperdriveId: string;
    name: string;
    accountId: string;
    scheme: HyperdriveScheme;
    host: string;
    port: number | undefined;
    database: string;
    user: string;
  },
  never,
  Providers
>;

/**
 * A Cloudflare Hyperdrive configuration.
 *
 * Hyperdrive accelerates and pools connections to existing PostgreSQL or
 * MySQL databases, exposing them to Workers via a binding. Create a config
 * as a resource, then bind it to a Worker to obtain a connection string.
 *
 * @section Creating a Hyperdrive
 * @example Public Postgres origin
 * ```typescript
 * const hd = yield* Cloudflare.Hyperdrive("my-pg", {
 *   origin: {
 *     scheme: "postgres",
 *     host: "db.example.com",
 *     port: 5432,
 *     database: "app",
 *     user: "app",
 *     password: alchemy.secret.env.DB_PASSWORD,
 *   },
 * });
 * ```
 *
 * @section Binding to a Worker
 * @example Using Hyperdrive inside a Worker
 * ```typescript
 * const hd = yield* Cloudflare.Hyperdrive.bind(MyDB);
 * const url = yield* hd.connectionString;
 * ```
 */
export const Hyperdrive = Resource<Hyperdrive>("Cloudflare.Hyperdrive")({
  bind: HyperdriveConnection.bind,
});

export const HyperdriveProvider = () =>
  Provider.effect(
    Hyperdrive,
    Effect.gen(function* () {
      const { accountId } = yield* CloudflareEnvironment;
      const createConfig = yield* hyperdrive.createConfig;
      const getConfig = yield* hyperdrive.getConfig;
      const updateConfig = yield* hyperdrive.updateConfig;
      const deleteConfig = yield* hyperdrive.deleteConfig;
      const listConfigs = yield* hyperdrive.listConfigs;

      const createConfigName = (id: string, name: string | undefined) =>
        Effect.gen(function* () {
          if (name) return name;
          return yield* createPhysicalName({ id, lowercase: true });
        });

      const findByName = (name: string) =>
        Effect.gen(function* () {
          const list = yield* listConfigs({ accountId });
          return list.result.find((c) => c.name === name);
        });

      return {
        stables: ["hyperdriveId", "accountId"],
        diff: Effect.fn(function* ({ id, olds, news, output }) {
          const ctx = yield* AlchemyContext;
          if (ctx.dev) return undefined;

          if (!isResolved(news)) return undefined;
          if ((output?.accountId ?? accountId) !== accountId) {
            return { action: "replace" } as const;
          }
          const name = yield* createConfigName(id, news.name);
          const oldName = output?.name
            ? output.name
            : yield* createConfigName(id, olds.name);
          if (oldName !== name) {
            return { action: "replace" } as const;
          }
        }),
        read: Effect.fn(function* ({ id, output, olds }) {
          const ctx = yield* AlchemyContext;
          if (ctx.dev) {
            return output;
          }

          if (output?.hyperdriveId) {
            return yield* getConfig({
              accountId: output.accountId,
              hyperdriveId: output.hyperdriveId,
            }).pipe(
              Effect.map((c) => ({
                hyperdriveId: c.id,
                name: c.name,
                accountId: output.accountId,
                scheme: c.origin.scheme,
                host: c.origin.host,
                port: "port" in c.origin ? c.origin.port : undefined,
                database: c.origin.database,
                user: c.origin.user,
              })),
              Effect.catchTag("HyperdriveConfigNotFound", () =>
                Effect.succeed(undefined),
              ),
            );
          }
          const name = yield* createConfigName(id, olds?.name);
          const match = yield* findByName(name);
          if (match) {
            return {
              hyperdriveId: match.id,
              name: match.name,
              accountId,
              scheme: match.origin.scheme,
              host: match.origin.host,
              port: "port" in match.origin ? match.origin.port : undefined,
              database: match.origin.database,
              user: match.origin.user,
            };
          }
          return undefined;
        }),
        create: Effect.fn(function* ({ id, news }) {
          const name = yield* createConfigName(id, news.name);

          const ctx = yield* AlchemyContext;
          if (ctx.dev) {
            return {
              hyperdriveId: "",
              name,
              accountId,
              ...projectOrigin(news.dev ?? news.origin),
            };
          }

          const body = {
            accountId,
            name,
            origin: toRequestOrigin(news.origin),
            caching: news.caching,
            mtls: news.mtls,
            originConnectionLimit: news.originConnectionLimit,
          };
          const created = yield* createConfig(body).pipe(
            Effect.catchTag("InvalidHyperdriveConfig", (originalError) =>
              Effect.gen(function* () {
                const match = yield* findByName(name);
                if (!match) {
                  return yield* Effect.fail(originalError);
                }
                return yield* updateConfig({
                  accountId,
                  hyperdriveId: match.id,
                  name,
                  origin: toRequestOrigin(news.origin),
                  caching: news.caching,
                  mtls: news.mtls,
                  originConnectionLimit: news.originConnectionLimit,
                });
              }),
            ),
          );
          return {
            hyperdriveId: created.id,
            name: created.name,
            accountId,
            ...projectOrigin(news.origin),
          };
        }),
        update: Effect.fn(function* ({ news, output }) {
          const ctx = yield* AlchemyContext;
          if (ctx.dev) {
            return {
              hyperdriveId: "",
              name: output.name,
              accountId,
              ...projectOrigin(news.dev ?? news.origin),
            };
          }

          const updated = yield* updateConfig({
            accountId: output.accountId,
            hyperdriveId: output.hyperdriveId,
            name: output.name,
            origin: toRequestOrigin(news.origin),
            caching: news.caching,
            mtls: news.mtls,
            originConnectionLimit: news.originConnectionLimit,
          });
          return {
            hyperdriveId: updated.id,
            name: updated.name,
            accountId: output.accountId,
            ...projectOrigin(news.origin),
          };
        }),
        delete: Effect.fn(function* ({ output }) {
          if (!output.hyperdriveId) return;

          yield* deleteConfig({
            accountId: output.accountId,
            hyperdriveId: output.hyperdriveId,
          }).pipe(
            Effect.catchTag("HyperdriveConfigNotFound", () => Effect.void),
          );
        }),
      };
    }),
  );

export const defaultPort = (scheme: HyperdriveScheme): number =>
  scheme === "mysql" ? 3306 : 5432;

const unwrap = (v: string | Redacted.Redacted<string>): string =>
  Redacted.isRedacted(v) ? Redacted.value(v) : v;

/**
 * Build the request body shape that the distilled `createConfig`/`updateConfig`
 * methods accept. Secrets are unwrapped here because the distilled TS types
 * declare `password`/`access_client_secret` as plain strings even though the
 * runtime schema also accepts `Redacted<string>`.
 */
const toRequestOrigin = (origin: HyperdriveOrigin) => {
  if ("accessClientId" in origin) {
    return {
      accessClientId: unwrap(origin.accessClientId),
      accessClientSecret: unwrap(origin.accessClientSecret),
      database: origin.database,
      host: origin.host,
      password: unwrap(origin.password),
      scheme: origin.scheme,
      user: origin.user,
    };
  }
  return {
    database: origin.database,
    host: origin.host,
    password: unwrap(origin.password),
    port: origin.port ?? defaultPort(origin.scheme),
    scheme: origin.scheme,
    user: origin.user,
  };
};

const projectOrigin = (origin: HyperdriveOrigin) => {
  if ("accessClientId" in origin) {
    return {
      scheme: origin.scheme,
      host: origin.host,
      port: undefined,
      database: origin.database,
      user: origin.user,
    };
  }
  return {
    scheme: origin.scheme,
    host: origin.host,
    port: origin.port ?? defaultPort(origin.scheme),
    database: origin.database,
    user: origin.user,
  };
};
