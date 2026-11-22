import type * as registry from "@distilled.cloud/azure/schemaregistry-data";

/**
 * Serialization format of a schema, sent as its `Content-Type`:
 *
 * - `Avro`: `application/json; serialization=Avro`
 * - `Json`: `application/json; serialization=Json`
 * - `Protobuf`: `text/vnd.ms.protobuf`
 * - `Custom`: `text/plain; charset=utf-8`
 */
export type SchemaFormat = "Avro" | "Json" | "Protobuf" | "Custom";

/** The `Content-Type` the Schema Registry data plane expects for each {@link SchemaFormat}. */
export const SchemaContentType: Record<SchemaFormat, string> = {
  Avro: "application/json; serialization=Avro",
  Json: "application/json; serialization=Json",
  Protobuf: "text/vnd.ms.protobuf",
  Custom: "text/plain; charset=utf-8",
};

/** Identity of one registered schema version. */
export interface SchemaProperties {
  /** Namespace-unique schema ID, the value producers put in their messages. */
  id: string;
  /** Schema group that holds the schema. */
  groupName: string;
  /** Name of the schema. */
  schemaName: string;
  /** Version number, starting at 1. */
  version: number;
}

/** One registered schema version and its text. */
export interface Schema extends SchemaProperties {
  /** The schema's `Content-Type`, e.g. `application/json; serialization=Avro`. */
  contentType: string | undefined;
  /** The schema text. */
  content: string;
}

/** Errors a schema read can fail with. */
export type SchemaReadError =
  | registry.GetSchemaByIdError
  | registry.GetSchemaByVersionError
  | registry.GetSchemaPropertiesByContentError
  | registry.ListSchemaVersionsError;

/** Errors a schema registration can fail with. */
export type SchemaWriteError = registry.RegisterSchemaError;
