import * as Coolify from "@distilled.cloud/coolify";
import { Unowned } from "alchemy/AdoptPolicy";
import { isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";
import { isGeneratedName, looksGenerated, resolveName } from "../internal/naming.ts";
import { syncTags } from "../internal/tags.ts";
import type { Providers } from "../Providers.ts";

export interface PostgresProps {
  /** UUID of the project, usually `project.projectUuid`. Changing it replaces the database. */
  project: string;
  /**
   * UUID of the environment, usually `environment.environmentUuid`. Set
   * this or {@link environmentName}. Changing it replaces the database.
   */
  environment?: string;
  /**
   * Name of the environment, e.g. `"production"`. Set this or
   * {@link environment}. Changing it replaces the database.
   */
  environmentName?: string;
  /**
   * UUID of the server that runs the database. Only a team admin's token may
   * use the server that runs Coolify itself (others get
   * `CoolifyHostRequiresAdmin`). Changing it replaces the database.
   */
  server: string;
  /**
   * UUID of the Docker network (destination) on the server. Only needed
   * when the server has more than one. Changing it replaces the database.
   */
  destination?: string;
  /**
   * Database name shown in the dashboard. If omitted, a unique name is
   * generated from the stack, stage and logical ID. Updates in place.
   */
  name?: string;
  /** Free-form description. Updates in place. */
  description?: string;
  /**
   * PostgreSQL image. Updating it restarts the database on the new image.
   * @default "postgres:17-alpine" (Coolify's default)
   */
  image?: string;
  /**
   * Superuser name. Postgres reads it only when it initialises the data
   * volume, so changing it replaces the database.
   * @default "postgres"
   */
  user?: string;
  /**
   * Superuser password. When omitted, Coolify generates one. Read only at
   * initialisation, so changing it replaces the database.
   */
  password?: string | Redacted.Redacted<string>;
  /**
   * Name of the database created at initialisation. Changing it replaces
   * the database.
   * @default "postgres"
   */
  database?: string;
  /** Extra `initdb` arguments. Changing it replaces the database. */
  initdbArgs?: string;
  /** `pg_hba.conf` method for host connections, e.g. `scram-sha-256`. Changing it replaces the database. */
  hostAuthMethod?: string;
  /** Contents of a custom `postgresql.conf`. Updating it restarts the database. */
  conf?: string;
  /**
   * Expose the database on {@link publicPort} of the server's public IP.
   * Applications on the same server don't need this; they use
   * `internalUrl`. Updating it restarts the database.
   * @default false
   */
  public?: boolean;
  /** Host port to publish on when {@link public} is true. */
  publicPort?: number;
  /** CPU and memory limits, in Docker's units. Updating them restarts the database. */
  limits?: { memory?: string; cpus?: string };
  /** Coolify tags (team-wide names). */
  tags?: string[];
}

export type Postgres = Resource<
  "Coolify.Database.Postgres",
  PostgresProps,
  {
    /** Database UUID. It is also the container's hostname on the server's Docker network. */
    databaseUuid: string;
    /** Database name in the dashboard. */
    name: string;
    /** UUID of the project the database belongs to. */
    projectUuid: string;
    /** UUID of the server it runs on. */
    serverUuid: string;
    /** Image the database runs. */
    image: string;
    /** Superuser name. */
    user: string;
    /** Name of the initial database. */
    database: string;
    /**
     * Superuser password. `undefined` when the API token lacks the
     * `read:sensitive` permission.
     */
    password: Redacted.Redacted<string> | undefined;
    /**
     * `postgres://` URL for applications on the same server, through the
     * Docker network. `undefined` when the API token lacks `read:sensitive`.
     */
    internalUrl: Redacted.Redacted<string> | undefined;
    /**
     * Public `postgres://` URL when {@link PostgresProps.public} is set and
     * the token has `read:sensitive`.
     */
    externalUrl: Redacted.Redacted<string> | undefined;
    /** Published host port, when public. */
    publicPort: number | undefined;
    /** Container status at the end of the deploy, e.g. `running:healthy`. */
    status: string;
  },
  never,
  Providers
>;

/**
 * A PostgreSQL database Coolify runs as a container on one of your
 * servers, with a persistent volume.
 *
 * Applications on the same server reach it through the Docker network with
 * `internalUrl`. Set `public: true` and a `publicPort` to reach it from
 * outside, through `externalUrl`. Reading the password and the URLs back
 * needs an API token with the `read:sensitive` permission.
 *
 * Deploys block until Coolify reports the container running. Settings that
 * Postgres only reads at initialisation (user, password, database,
 * `initdb` arguments) replace the database, which starts from an empty
 * volume; everything else updates in place and restarts the container.
 *
 * @see https://coolify.io/docs/databases/postgresql
 *
 * ### Creating a Database
 * **Example:** Postgres with a generated password
 * ```typescript
 * const project = yield* Coolify.Project("app", {});
 *
 * const db = yield* Coolify.Database.Postgres("db", {
 *   project: project.projectUuid,
 *   environmentName: "production",
 *   server: "<server-uuid>",
 * });
 * ```
 *
 * **Example:** Pinned image, named database and limits
 * ```typescript
 * const db = yield* Coolify.Database.Postgres("orders", {
 *   project: project.projectUuid,
 *   environment: staging.environmentUuid,
 *   server: "<server-uuid>",
 *   image: "postgres:17.2-alpine",
 *   database: "orders",
 *   limits: { memory: "1g", cpus: "1" },
 * });
 * ```
 *
 * ### Connecting from an Application
 * **Example:** Pass the internal URL as an env var
 * ```typescript
 * yield* Coolify.Application("api", {
 *   project: project.projectUuid,
 *   environmentName: "production",
 *   server: "<server-uuid>",
 *   image: "ghcr.io/acme/api:1.4.2",
 *   ports: [3000],
 *   env: { DATABASE_URL: db.internalUrl },
 * });
 * ```
 *
 * ### Exposing a Database publicly
 * **Example:** Reach the database from your machine
 * ```typescript
 * const db = yield* Coolify.Database.Postgres("db", {
 *   project: project.projectUuid,
 *   environmentName: "production",
 *   server: "<server-uuid>",
 *   public: true,
 *   publicPort: 54321,
 * });
 *
 * return { url: db.externalUrl };
 * ```
 *
 * @resource
 * @product Postgres
 */
export const Postgres = Resource<Postgres>("Coolify.Database.Postgres");

/** Neither `environment` nor `environmentName` was set. */
export class DatabaseEnvironmentRequired extends Data.TaggedError(
  "Coolify.DatabaseEnvironmentRequired",
)<{ readonly message: string }> {}

/** Coolify returned a database without the fields Alchemy needs. */
export class DatabaseUnexpectedResponse extends Data.TaggedError(
  "Coolify.DatabaseUnexpectedResponse",
)<{ readonly message: string }> {}

/** The database container did not report `running` in time. */
export class DatabaseNotRunning extends Data.TaggedError("Coolify.DatabaseNotRunning")<{
  readonly message: string;
  readonly databaseUuid: string;
  readonly status: string;
}> {}

const unwrap = (value: string | Redacted.Redacted<string> | null | undefined) =>
  value == null ? undefined : Redacted.isRedacted(value) ? Redacted.value(value) : value;

const redact = (value: string | Redacted.Redacted<string> | null | undefined) => {
  const plain = unwrap(value);
  return plain === undefined || plain.length === 0 ? undefined : Redacted.make(plain);
};

// Settings Postgres reads only when it initialises the data volume.
const INIT_ONLY = ["user", "password", "database", "initdbArgs", "hostAuthMethod"] as const;

export const PostgresProvider = () =>
  Provider.effect(
    Postgres,
    Effect.gen(function* () {
      const getDatabase = yield* Coolify.getDatabase;
      const listDatabases = yield* Coolify.listDatabases;
      const createPostgres = yield* Coolify.createDatabasePostgresql;
      const updateDatabase = yield* Coolify.updateDatabaseByUuid;
      const deleteDatabase = yield* Coolify.deleteDatabase;
      const startDatabase = yield* Coolify.startDatabaseByUuid;
      const restartDatabase = yield* Coolify.restartDatabaseByUuid;
      const listTags = yield* Coolify.listTagsByDatabaseUuid;
      const addTags = yield* Coolify.createTagByDatabaseUuid;
      const removeTag = yield* Coolify.deleteTagByDatabaseUuid;

      const observe = (uuid: string) =>
        getDatabase({ uuid }).pipe(Effect.catchTag("NotFound", () => Effect.undefined));

      const toAttrs = (db: Coolify.Database, fields: { projectUuid: string; serverUuid: string }) =>
        Effect.gen(function* () {
          if (!db.uuid || db.name === undefined) {
            return yield* new DatabaseUnexpectedResponse({
              message: "Coolify returned a database without a uuid or name",
            });
          }
          return {
            databaseUuid: db.uuid,
            name: db.name,
            image: db.image ?? "",
            user: db.postgres_user ?? "postgres",
            database: db.postgres_db ?? "postgres",
            password: redact(db.postgres_password),
            internalUrl: redact(db.internal_db_url),
            externalUrl: redact(db.external_db_url),
            publicPort: db.is_public ? (db.public_port ?? undefined) : undefined,
            status: db.status ?? "unknown",
            ...fields,
          } satisfies Postgres["Attributes"];
        });

      // Coolify writes container status from its status checker, so it can
      // trail the start by a poll interval.
      const waitUntilRunning = Effect.fn(function* (uuid: string) {
        const db = yield* getDatabase({ uuid }).pipe(
          Effect.repeat({
            schedule: Schedule.spaced("3 seconds"),
            until: (d) => (d.status ?? "").startsWith("running"),
            times: 80,
          }),
        );
        if (!(db.status ?? "").startsWith("running")) {
          return yield* new DatabaseNotRunning({
            message: `Database ${uuid} is ${db.status ?? "unknown"} after 4 minutes`,
            databaseUuid: uuid,
            status: db.status ?? "unknown",
          });
        }
        return db;
      });

      const base64 = (content: string) =>
        Effect.sync(() => Buffer.from(content, "utf8").toString("base64"));

      return {
        stables: ["databaseUuid", "projectUuid", "serverUuid"],
        nuke: { dependsOn: ["Coolify.Project", "Coolify.Environment"] },

        list: () =>
          Effect.gen(function* () {
            const dbs = yield* listDatabases({});
            return yield* Effect.forEach(
              dbs.filter(
                (db) => db.database_type === "standalone-postgresql" && looksGenerated(db.name),
              ),
              (db) => toAttrs(db, { projectUuid: "", serverUuid: "" }),
            );
          }),

        diff: Effect.fn(function* ({ olds, news, output }) {
          if (!isResolved(news) || output === undefined) return undefined;
          if (news.project !== output.projectUuid || news.server !== output.serverUuid) {
            return { action: "replace" } as const;
          }
          // Adopted: there are no previous props to compare against.
          if (olds === undefined) return undefined;
          if (
            news.environment !== olds.environment ||
            news.environmentName !== olds.environmentName ||
            news.destination !== olds.destination
          ) {
            return { action: "replace" } as const;
          }
          for (const key of INIT_ONLY) {
            const before = key === "password" ? unwrap(olds.password) : olds[key];
            const after = key === "password" ? unwrap(news.password) : news[key];
            if (before !== after) return { action: "replace" } as const;
          }
          return undefined;
        }),

        read: Effect.fn(function* ({ id, olds, output }) {
          if (output?.databaseUuid) {
            const db = yield* observe(output.databaseUuid);
            if (!db) return undefined;
            return yield* toAttrs(db, {
              projectUuid: output.projectUuid,
              serverUuid: output.serverUuid,
            });
          }
          if (!olds) return undefined;
          const name = yield* resolveName(id, olds.name);
          const db = (yield* listDatabases({})).find(
            (d) => d.name === name && d.database_type === "standalone-postgresql",
          );
          if (!db) return undefined;
          const attrs = yield* toAttrs(db, { projectUuid: olds.project, serverUuid: olds.server });
          return (yield* isGeneratedName(id, db.name)) ? attrs : Unowned(attrs);
        }),

        reconcile: Effect.fn(function* ({ id, news, output }) {
          if (news.environment === undefined && news.environmentName === undefined) {
            return yield* new DatabaseEnvironmentRequired({
              message: "Coolify.Database.Postgres needs `environment` or `environmentName`",
            });
          }
          const name = yield* resolveName(id, news.name, output?.name);

          // Observe
          let db = output?.databaseUuid ? yield* observe(output.databaseUuid) : undefined;

          // Ensure — create and start in one call.
          if (db === undefined) {
            const created = yield* createPostgres({
              project_uuid: news.project,
              server_uuid: news.server,
              environment_uuid: news.environment,
              environment_name: news.environment === undefined ? news.environmentName : undefined,
              destination_uuid: news.destination,
              name,
              description: news.description,
              image: news.image,
              postgres_user: news.user,
              postgres_password: news.password,
              postgres_db: news.database,
              postgres_initdb_args: news.initdbArgs,
              postgres_host_auth_method: news.hostAuthMethod,
              postgres_conf: news.conf === undefined ? undefined : yield* base64(news.conf),
              is_public: news.public,
              public_port: news.publicPort,
              limits_memory: news.limits?.memory,
              limits_cpus: news.limits?.cpus,
              tags: news.tags,
              instant_deploy: true,
            });
            db = yield* getDatabase({ uuid: created.uuid });
          }
          const uuid = db.uuid!;

          // Sync — mutable settings, against the observed database.
          const update: Partial<Coolify.UpdateDatabaseByUuidRequest> = {};
          if (db.name !== name) update.name = name;
          if ((db.description ?? undefined) !== news.description) {
            update.description = news.description ?? "";
          }
          if (news.image !== undefined && db.image !== news.image) update.image = news.image;
          if (news.public !== undefined && db.is_public !== news.public) {
            update.is_public = news.public;
          }
          if (news.publicPort !== undefined && db.public_port !== news.publicPort) {
            update.public_port = news.publicPort;
          }
          if (news.limits?.memory !== undefined && db.limits_memory !== news.limits.memory) {
            update.limits_memory = news.limits.memory;
          }
          if (news.limits?.cpus !== undefined && db.limits_cpus !== news.limits.cpus) {
            update.limits_cpus = news.limits.cpus;
          }
          // postgres_conf is withheld from tokens without read:sensitive;
          // only rewrite it when we can see that it differs.
          const observedConf = unwrap(db.postgres_conf);
          if (news.conf !== undefined && observedConf !== undefined && observedConf !== news.conf) {
            update.postgres_conf = yield* base64(news.conf);
          }
          const changed = Object.keys(update).length > 0;
          if (changed) {
            yield* updateDatabase({ uuid, ...update }).pipe(
              // 409 while a start or stop is still running.
              Effect.retry({
                while: (e) => e._tag === "Conflict",
                schedule: Schedule.spaced("3 seconds"),
                times: 10,
              }),
            );
          }

          if (news.tags !== undefined) {
            yield* syncTags({
              list: () => listTags({ uuid }),
              add: (names) => addTags({ uuid, tag_names: names }),
              remove: (tagUuid) => removeTag({ uuid, tag_uuid: tagUuid }),
              desired: news.tags,
            });
          }

          // Settings that touch the container apply on restart; a stopped
          // database is started.
          const running = (db.status ?? "").startsWith("running");
          const needsRestart =
            update.image !== undefined ||
            update.is_public !== undefined ||
            update.public_port !== undefined ||
            update.limits_memory !== undefined ||
            update.limits_cpus !== undefined ||
            update.postgres_conf !== undefined;
          if (!running && !(db.status ?? "").startsWith("starting")) {
            yield* startDatabase({ uuid }).pipe(Effect.catchTag("Conflict", () => Effect.void));
          } else if (needsRestart) {
            yield* restartDatabase({ uuid });
          }

          return yield* toAttrs(yield* waitUntilRunning(uuid), {
            projectUuid: news.project,
            serverUuid: news.server,
          });
        }),

        delete: Effect.fn(function* ({ output }) {
          yield* deleteDatabase({
            uuid: output.databaseUuid,
            delete_configurations: true,
            delete_volumes: true,
            docker_cleanup: true,
            delete_connected_networks: true,
          }).pipe(Effect.catchTag("NotFound", () => Effect.void));
        }),
      };
    }),
  );
