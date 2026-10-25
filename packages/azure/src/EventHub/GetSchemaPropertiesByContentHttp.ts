import * as registry from "@distilled.cloud/azure/schemaregistry-data";
import * as Layer from "effect/Layer";
import { GetSchemaPropertiesByContent } from "./GetSchemaPropertiesByContent.ts";
import { makeSchemaGroupOperationBinding } from "./SchemaRegistryBindingHttp.ts";

/**
 * Implementation of {@link GetSchemaPropertiesByContent} over the distilled `schemaregistry-data`
 * data plane. Assigns **Schema Registry Reader** on the schema group.
 *
 * @layer
 * @provides Azure.EventHub.GetSchemaPropertiesByContent
 */
export const GetSchemaPropertiesByContentHttp = Layer.effect(
  GetSchemaPropertiesByContent,
  makeSchemaGroupOperationBinding({
    tag: "Azure.EventHub.GetSchemaPropertiesByContent",
    operation: registry.GetSchemaPropertiesByContent,
    access: "read",
    supplies: ["fullyQualifiedNamespace", "groupName"],
  }),
);
