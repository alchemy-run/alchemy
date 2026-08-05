import * as Redacted from "effect/Redacted";
import { Resource } from "../Resource.ts";
import type { Providers } from "./Providers.ts";
import type { PostgresOrigin } from "./PostgresOrigin.ts";

type Without<T, U> = { [P in Exclude<keyof T, keyof U>]?: never };
type XOR<T, U> = (Without<T, U> & U) | (Without<U, T> & T);

type ConnectionFields = {
  host?: string;
  port?: number;
  user?: string;
  password?: string;
  database?: string;
};

type ExclusiveConnection = XOR<
  { connectionString: string },
  ConnectionFields
>;

export interface DockerDatabaseProps {
  image?: string;
  port?: number;
}

type DevPassthroughFields = {
  connectionString?: string;
  host?: string;
  port?: number;
  user?: string;
  password?: string;
  database?: string;
};

type ExclusiveDev = XOR<
  { docker: DockerDatabaseProps },
  DevPassthroughFields
>;

export type DatabaseProps = ExclusiveConnection & {
  /**
   * Directory containing `.sql` migration files. Files are sorted by their
   * numeric prefix (e.g. `0001_init.sql`) and applied in order.
   */
  migrationsDir?: string;
  /**
   * Name of the table used to track applied migrations.
   *
   * @default "__alchemy_migrations"
   */
  migrationsTable?: string;
  /**
   * Paths to additional `.sql` files to apply after migrations.
   * Each file is hashed and re-applied only when its contents change.
   */
  importFiles?: string[];
  /**
   * Dev mode configuration. In dev mode, connection params are taken
   * from `dev` (with fallback to top-level). If `dev.docker` is set,
   * a local Postgres Docker container is started automatically.
   */
  dev?: ExclusiveDev;
};

export interface Database extends Resource<
  "Postgres.Database",
  DatabaseProps,
  {
    host: string;
    port: number;
    user: string;
    password: Redacted.Redacted<string>;
    database: string;
    connectionUri: string;
    origin: PostgresOrigin;
    migrationsDir: string | undefined;
    migrationsTable: string | undefined;
    migrationsHashes: Record<string, string>;
    importHashes: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * A generic Postgres database connection with built-in migration support.
 *
 * Unlike provider-specific resources like `Neon.Project` or
 * `Planetscale.PostgresDatabase`, this resource connects to any Postgres
 * instance — self-hosted, cloud-hosted, or local. It handles migrations
 * using the same `migrationsDir` / `importFiles` pattern as Neon and
 * PlanetScale.
 *
 * In dev mode, it can automatically start a local Postgres Docker container
 * so you never have to set up a database manually.
 *
 * @resource
 *
 * @section Basic usage
 * @example Connect to a Postgres instance by URL
 * ```typescript
 * const db = yield* Postgres.Database("my-db", {
 *   connectionString: Secret("DATABASE_URL"),
 *   migrationsDir: "./migrations",
 * });
 * ```
 *
 * @example Connect by individual params
 * ```typescript
 * const db = yield* Postgres.Database("my-db", {
 *   host: "db.internal",
 *   port: 5432,
 *   user: "app",
 *   password: Secret("DB_PASSWORD"),
 *   database: "my_app",
 *   migrationsDir: "./migrations",
 * });
 * ```
 *
 * @section Dev with Docker
 * @example Auto-start a local Postgres container in dev
 * ```typescript
 * const db = yield* Postgres.Database("my-db", {
 *   host: "rds.internal",
 *   user: "app",
 *   password: Secret("DB_PASSWORD"),
 *   database: "my_app",
 *   migrationsDir: "./migrations",
 *   dev: {
 *     docker: {
 *       image: "postgres:18-alpine",
 *     },
 *   },
 * });
 * ```
 *
 * @section Dev with passthrough
 * @example Use a different host/port in dev
 * ```typescript
 * const db = yield* Postgres.Database("my-db", {
 *   connectionString: Secret("PROD_DATABASE_URL"),
 *   migrationsDir: "./migrations",
 *   dev: {
 *     host: "localhost",
 *     user: "dev_user",
 *     database: "dev_app",
 *   },
 * });
 * ```
 *
 * @section Feeding into Hyperdrive
 * @example Wire into Hyperdrive for Cloudflare Workers
 * ```typescript
 * const db = yield* Postgres.Database("my-db", {
 *   connectionString: Secret("DATABASE_URL"),
 * });
 * const hd = yield* Cloudflare.Hyperdrive.Connection("app-hd", {
 *   origin: db.origin,
 * });
 * ```
 *
 * @section Seed data
 * @example Run seed files after migrations
 * ```typescript
 * const db = yield* Postgres.Database("my-db", {
 *   connectionString: Secret("DATABASE_URL"),
 *   migrationsDir: "./migrations",
 *   importFiles: ["./seed/users.sql"],
 * });
 * ```
 */
export const Database = Resource<Database>("Postgres.Database");
