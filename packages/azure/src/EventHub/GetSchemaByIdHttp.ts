import * as registry from "@distilled.cloud/azure/schemaregistry-data";
import * as Layer from "effect/Layer";
import { GetSchemaById } from "./GetSchemaById.ts";
import { makeSchemaGroupOperationBinding } from "./SchemaRegistryBindingHttp.ts";

/**
 * Implementation of {@link GetSchemaById} over the distilled `schemaregistry-data`
 * data plane. Assigns **Schema Registry Reader** on the schema group.
 *
 * @layer
 * @provides Azure.EventHub.GetSchemaById
 */
export const GetSchemaByIdHttp = Layer.effect(
  GetSchemaById,
  makeSchemaGroupOperationBinding({
    tag: "Azure.EventHub.GetSchemaById",
    operation: registry.GetSchemaById,
    access: "read",
    supplies: ["fullyQualifiedNamespace"],
  }),
);
