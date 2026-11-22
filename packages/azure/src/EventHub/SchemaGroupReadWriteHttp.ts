import * as Layer from "effect/Layer";
import { SchemaGroupReadWrite } from "./SchemaGroupReadWrite.ts";
import { makeSchemaGroupBinding } from "./SchemaRegistryBindingHttp.ts";

/**
 * Implementation of {@link SchemaGroupReadWrite} over the distilled
 * `schemaregistry-data` data plane. Assigns **Schema Registry Reader** on
 * the schema group and a custom role with only `schemas/write` on its
 * namespace.
 *
 * @layer
 * @provides Azure.EventHub.SchemaGroupReadWrite
 */
export const SchemaGroupReadWriteHttp = Layer.effect(
  SchemaGroupReadWrite,
  makeSchemaGroupBinding({
    tag: "Azure.EventHub.SchemaGroupReadWrite",
    access: ["read", "write"],
    makeClient: (helpers, address) => ({
      ...helpers.makeRead(address),
      ...helpers.makeWrite(address),
    }),
  }),
);
