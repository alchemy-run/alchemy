/**
 * Domain projections exported to stores you own (Iceberg, ClickHouse,
 * Postgres) and queried in SQL. A table is a projection; a store holds
 * tables; an engine queries stores.
 *
 * Entry points that need an optional dependency stand alone:
 * `@alchemy.run/domain/Export/DuckDb` (`@duckdb/node-api`),
 * `@alchemy.run/domain/Export/Iceberg` (a store on any Iceberg catalog,
 * written through DuckDB), and `@alchemy.run/domain/Export/Athena`
 * (`@alchemy.run/aws`).
 *
 * @module
 */
import * as EngineModule from "./Engine.ts";
import * as StoreModule from "./Store.ts";
import * as TableModule from "./Table.ts";

export declare namespace Table {
  /** Any table class. */
  export type Any = TableModule.Any;
  /** A row as a table's reader returns it. */
  export type Read<T extends { readonly Read: { readonly Type: unknown } }> = T["Read"]["Type"];
}
export const Table = TableModule.make;

export declare namespace Store {
  /** Any store declaration. */
  export type Any = StoreModule.Any;
  /** What a store's Layer builds once. */
  export type Implementation = StoreModule.Implementation;
}
export const Store = StoreModule.make;

export declare namespace Engine {
  /** What an engine's Layer builds once. */
  export type Implementation = EngineModule.Implementation;
  /** The SQL an engine speaks. */
  export type Dialect = EngineModule.Dialect;
}
export const Engine = EngineModule.make;

export * as Metadata from "./Metadata.ts";
export * as Sensitive from "./Sensitive.ts";
export * as Spec from "./Spec.ts";
export {
  DefinitionError,
  DialectMismatch,
  DuplicateTableName,
  MetadataRedefined,
  MetadataWithoutValue,
  TableNotInEngine,
  UnprotectedSensitive,
  UnsupportedType,
} from "./DefinitionError.ts";
export {
  ClientTimeZone,
  EngineUnavailable,
  ExpectedOneRow,
  QueryFailed,
  QueryRefused,
  ResultDecodeFailed,
  UnsupportedDialect,
} from "./Engine.ts";
export { RowDecodeFailed, SchemaDrift, StatementRejected, Unavailable } from "./Store.ts";
