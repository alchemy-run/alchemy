import { Resource } from "alchemy/Resource";
import { type BaseBranchAttributes, type BaseBranchProps, makeBranchProvider } from "../Branch.ts";
import type { Providers } from "../Providers.ts";
import type { PostgresClusterSize } from "./PostgresClusterSize.ts";
import type { PostgresDatabase } from "./PostgresDatabase.ts";
import { runPostgresImports, runPostgresMigrations } from "./PostgresMigrations.ts";

/**
 * Properties for creating or updating a {@link PostgresBranch}.
 */
export interface PostgresBranchProps extends BaseBranchProps {
  /**
   * The Postgres database. Either a string database name or a
   * {@link PostgresDatabase} resource.
   */
  database: string | PostgresDatabase;

  /**
   * PostgreSQL cluster size for the branch. Required if `backupId` is provided.
   * Short NAS sizes are expanded using the parent branch's region and CPU
   * architecture (e.g. `"PS_DEV"` off an ARM parent becomes `"PS_DEV_AWS_ARM"`). Metal
   * requires the full SKU (e.g. `"M1_10_AWS_ARM_D_METAL_10"`).
   */
  clusterSize?: PostgresClusterSize;

  /**
   * Total number of replicas for the branch. `0` creates or converges the
   * branch to non-HA/single-node; `2+` enables HA.
   */
  replicas?: number;

  /**
   * Parent branch — either a string name or another {@link PostgresBranch}.
   * @default "main"
   */
  parentBranch?: string | PostgresBranch;
}

/**
 * Output attributes of a deployed {@link PostgresBranch}.
 */
export interface PostgresBranchAttributes extends BaseBranchAttributes {}

/**
 * A PlanetScale branch of a {@link PostgresDatabase}. For MySQL branches
 * use {@link MySQLBranch} instead.
 *
 * ### Creating a Branch
 * **Example:** Branch from main
 * ```typescript
 * const branch = yield* Planetscale.PostgresBranch("Feature123", {
 *   database: "my-db",
 *   parentBranch: "main",
 * });
 * ```
 *
 * **Example:** Branch from a PostgresDatabase resource
 * ```typescript
 * const db = yield* Planetscale.PostgresDatabase("MyDb", { clusterSize: "PS_10" });
 * const branch = yield* Planetscale.PostgresBranch("Feature456", {
 *   database: db,
 *   parentBranch: "main",
 * });
 * ```
 *
 * ### Migrations and seed data
 * **Example:** Apply migrations on a branch
 * ```typescript
 * const branch = yield* Planetscale.PostgresBranch("Feature123", {
 *   database: db,
 *   parentBranch: "main",
 *   migrationsDir: "./migrations",
 *   importFiles: ["./seed.sql"],
 * });
 * ```
 */
export type PostgresBranch = Resource<
  "Planetscale.PostgresBranch",
  PostgresBranchProps,
  PostgresBranchAttributes,
  never,
  Providers,
  PostgresBranchLookup
>;

/**
 * Props for {@link PostgresBranch.lookup}: find a Postgres branch this
 * stack doesn't manage by its database and name.
 */
export interface PostgresBranchLookup {
  /** Database name. */
  database: string;
  /** Branch name. */
  name: string;
}

/**
 * A branch of a PlanetScale Postgres database.
 *
 * ### Looking up an existing Postgres branch
 * `PostgresBranch.lookup` references a Postgres branch Alchemy doesn't manage (created in
 * the PlanetScale dashboard or by another stack). It is read during
 * plan/deploy, never created, updated or deleted.
 *
 * **Example:** Reference an existing branch
 * ```typescript
 * const main = Planetscale.PostgresBranch.lookup({ database: "app", name: "main" });
 * ```
 *
 * @resource
 */
export const PostgresBranch = Resource<PostgresBranch>("Planetscale.PostgresBranch");

export const PostgresBranchProvider = () =>
  makeBranchProvider({
    resource: PostgresBranch,
    expectedKind: "postgresql",
    engineLabel: "PostgresBranch",
    runners: {
      runMigrations: runPostgresMigrations,
      runImports: runPostgresImports,
    },
  });
