import * as registry from "@distilled.cloud/azure/schemaregistry-data";
import * as Layer from "effect/Layer";
import { RegisterSchema } from "./RegisterSchema.ts";
import { makeSchemaGroupOperationBinding } from "./SchemaRegistryBindingHttp.ts";

/**
 * Implementation of {@link RegisterSchema} over the distilled `schemaregistry-data`
 * data plane. Assigns a custom role with only `schemas/write` on the
 * schema group's namespace.
 *
 * @layer
 * @provides Azure.EventHub.RegisterSchema
 */
export const RegisterSchemaHttp = Layer.effect(
  RegisterSchema,
  makeSchemaGroupOperationBinding({
    tag: "Azure.EventHub.RegisterSchema",
    operation: registry.RegisterSchema,
    access: "write",
    supplies: ["fullyQualifiedNamespace", "groupName"],
  }),
);
