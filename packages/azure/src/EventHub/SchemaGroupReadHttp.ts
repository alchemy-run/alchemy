import * as Layer from "effect/Layer";
import { SchemaGroupRead } from "./SchemaGroupRead.ts";
import { makeSchemaGroupBinding } from "./SchemaRegistryBindingHttp.ts";

/**
 * Implementation of {@link SchemaGroupRead} over the distilled
 * `schemaregistry-data` data plane. Assigns **Schema Registry Reader** on
 * the schema group.
 *
 * @layer
 * @provides Azure.EventHub.SchemaGroupRead
 */
export const SchemaGroupReadHttp = Layer.effect(
  SchemaGroupRead,
  makeSchemaGroupBinding({
    tag: "Azure.EventHub.SchemaGroupRead",
    access: ["read"],
    makeClient: (helpers, address) => helpers.makeRead(address),
  }),
);
