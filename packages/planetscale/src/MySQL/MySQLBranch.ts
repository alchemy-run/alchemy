import { Resource } from "alchemy/Resource";
import { type BaseBranchAttributes, type BaseBranchProps, makeBranchProvider } from "../Branch.ts";
import type { Providers } from "../Providers.ts";
import type { MySQLClusterSize } from "./MySQLClusterSize.ts";
import type { MySQLDatabase } from "./MySQLDatabase.ts";
import { runMySQLImports, runMySQLMigrations } from "./MySQLMigrations.ts";

/**
 * Properties for creating or updating a {@link MySQLBranch}.
 */
export interface MySQLBranchProps extends BaseBranchProps {
  /**
   * Whether the branch should be a production branch.
   */
  isProduction: boolean;

  /**
   * The MySQL database. Either a string database name or a
   * {@link MySQLDatabase} resource.
   */
  database: string | MySQLDatabase;

  /**
   * MySQL cluster size for the branch. Required if `backupId` is provided.
   * For non-production branches must be `"PS_DEV"`.
   */
  clusterSize?: MySQLClusterSize;

  /**
   * Parent branch — either a string name or another {@link MySQLBranch}.
   * @default "main"
   */
  parentBranch?: string | MySQLBranch;
}

/**
 * Output attributes of a deployed {@link MySQLBranch}.
 */
export interface MySQLBranchAttributes extends BaseBranchAttributes {}

/**
 * A PlanetScale branch of a {@link MySQLDatabase}. For PostgreSQL branches
 * use {@link PostgresBranch} instead.
 *
 * ### Creating a Branch
 * **Example:** Branch from main
 * ```typescript
 * const branch = yield* Planetscale.MySQLBranch("Feature123", {
 *   database: "my-db",
 *   parentBranch: "main",
 *   isProduction: false,
 * });
 * ```
 *
 * **Example:** Branch from a MySQLDatabase resource
 * ```typescript
 * const db = yield* Planetscale.MySQLDatabase("MyDb", { clusterSize: "PS_10" });
 * const branch = yield* Planetscale.MySQLBranch("Feature456", {
 *   database: db,
 *   parentBranch: "main",
 *   isProduction: false,
 * });
 * ```
 *
 * ### Restoring from Backup
 * **Example:** Branch restored from a backup
 * ```typescript
 * const branch = yield* Planetscale.MySQLBranch("Restored", {
 *   database: "my-db",
 *   parentBranch: "main",
 *   isProduction: true,
 *   backupId: "backup-123",
 *   clusterSize: "PS_10",
 * });
 * ```
 *
 * ### Migrations and seed data
 * **Example:** Apply migrations on a branch
 * ```typescript
 * const branch = yield* Planetscale.MySQLBranch("Feature123", {
 *   database: db,
 *   parentBranch: "main",
 *   isProduction: false,
 *   migrationsDir: "./migrations",
 *   importFiles: ["./seed.sql"],
 * });
 * ```
 */
export type MySQLBranch = Resource<
  "Planetscale.MySQLBranch",
  MySQLBranchProps,
  MySQLBranchAttributes,
  never,
  Providers,
  MySQLBranchLookup
>;

/**
 * Props for {@link MySQLBranch.lookup}: find a MySQL branch this
 * stack doesn't manage by its database and name.
 */
export interface MySQLBranchLookup {
  /** Database name. */
  database: string;
  /** Branch name. */
  name: string;
}

/**
 * A branch of a PlanetScale MySQL database.
 *
 * ### Looking up an existing MySQL branch
 * `MySQLBranch.lookup` references a MySQL branch Alchemy doesn't manage (created in
 * the PlanetScale dashboard or by another stack). It is read during
 * plan/deploy, never created, updated or deleted.
 *
 * **Example:** Reference an existing branch
 * ```typescript
 * const main = Planetscale.MySQLBranch.lookup({ database: "app", name: "main" });
 * ```
 *
 * @resource
 */
export const MySQLBranch = Resource<MySQLBranch>("Planetscale.MySQLBranch");

export const MySQLBranchProvider = () =>
  makeBranchProvider({
    resource: MySQLBranch,
    expectedKind: "mysql",
    engineLabel: "MySQLBranch",
    runners: {
      runMigrations: runMySQLMigrations,
      runImports: runMySQLImports,
    },
  });
