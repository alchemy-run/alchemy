import { Resource } from "../../resource.ts";

/**
 * Primary location hints for D1 database placement
 */
export type PrimaryLocationHint =
  | "wnam" // Western North America
  | "enam" // Eastern North America
  | "weur" // Western Europe
  | "eeur" // Eastern Europe
  | "apac" // Asia Pacific
  | "oc" // Oceania
  | (string & {});

/**
 * Jurisdiction for D1 database data residency
 */
export type D1Jurisdiction = "default" | "eu" | "fedramp";

/**
 * Read replication mode for D1 database
 */
export type ReadReplicationMode = "auto" | "disabled";

export type DatabaseProps = {
  /**
   * Name of the database
   * @default Generated from physical name
   */
  name?: string;

  /**
   * Optional primary location hint for the database.
   * Indicates the primary geographical location data will be stored.
   */
  primaryLocationHint?: PrimaryLocationHint;

  /**
   * Read replication configuration.
   * Only mutable property during updates.
   */
  readReplication?: {
    mode: ReadReplicationMode;
  };

  /**
   * Optional jurisdiction for the database.
   * Determines the regulatory jurisdiction the database data falls under.
   * @default "default"
   */
  jurisdiction?: D1Jurisdiction;

  /**
   * Whether to adopt an existing database with the same name if it exists.
   * If true and a database with the same name exists, it will be adopted
   * rather than creating a new one.
   * @default false
   */
  adopt?: boolean;

  /**
   * Whether to delete the database when the resource is destroyed.
   * If set to false, the database will remain but the resource will be
   * removed from state.
   * @default true
   */
  delete?: boolean;
};

export type DatabaseAttr<Props extends DatabaseProps> = {
  /**
   * The unique ID of the database (UUID)
   */
  databaseId: string;

  /**
   * The name of the database
   */
  databaseName: Props["name"] extends string ? Props["name"] : string;

  /**
   * The account ID the database belongs to
   */
  accountId: string;

  /**
   * The jurisdiction of the database
   */
  jurisdiction: Props["jurisdiction"] extends D1Jurisdiction
    ? Props["jurisdiction"]
    : "default";

  /**
   * Primary location hint for the database
   */
  primaryLocationHint: Props["primaryLocationHint"] extends PrimaryLocationHint
    ? Props["primaryLocationHint"]
    : undefined;

  /**
   * Read replication configuration
   */
  readReplication: Props["readReplication"] extends { mode: ReadReplicationMode }
    ? Props["readReplication"]
    : { mode: "disabled" };

  /**
   * Database version
   */
  version: string;

  /**
   * Number of tables in the database
   */
  numTables: number;

  /**
   * Database file size in bytes
   */
  fileSize: number;

  /**
   * Region where the database is running
   */
  runningInRegion: string;

  /**
   * Time the database was created
   */
  createdAt: string;
};

export interface Database<
  ID extends string = string,
  Props extends DatabaseProps = DatabaseProps,
> extends Resource<
  "Cloudflare.D1.Database",
  ID,
  Props,
  DatabaseAttr<Props>,
  Database
> {}

export const Database = Resource<{
  <const ID extends string, const Props extends DatabaseProps>(
    id: ID,
    props?: Props,
  ): Database<ID, Props>;
}>("Cloudflare.D1.Database");
