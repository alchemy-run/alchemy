import * as Layer from "effect/Layer";
import { SchemaGroupWrite } from "./SchemaGroupWrite.ts";
import { makeSchemaGroupBinding } from "./SchemaRegistryBindingHttp.ts";

/**
 * Implementation of {@link SchemaGroupWrite} over the distilled
 * `schemaregistry-data` data plane. Assigns a custom role with only `schemas/write` on the
 * schema group's namespace.
 *
 * @layer
 * @provides Azure.EventHub.SchemaGroupWrite
 */
export const SchemaGroupWriteHttp = Layer.effect(
  SchemaGroupWrite,
  makeSchemaGroupBinding({
    tag: "Azure.EventHub.SchemaGroupWrite",
    access: ["write"],
    makeClient: (helpers, address) => helpers.makeWrite(address),
  }),
);
