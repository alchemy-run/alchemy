import * as registry from "@distilled.cloud/azure/schemaregistry-data";
import * as Layer from "effect/Layer";
import { GetSchemaByVersion } from "./GetSchemaByVersion.ts";
import { makeSchemaGroupOperationBinding } from "./SchemaRegistryBindingHttp.ts";

/**
 * Implementation of {@link GetSchemaByVersion} over the distilled `schemaregistry-data`
 * data plane. Assigns **Schema Registry Reader** on the schema group.
 *
 * @layer
 * @provides Azure.EventHub.GetSchemaByVersion
 */
export const GetSchemaByVersionHttp = Layer.effect(
  GetSchemaByVersion,
  makeSchemaGroupOperationBinding({
    tag: "Azure.EventHub.GetSchemaByVersion",
    operation: registry.GetSchemaByVersion,
    access: "read",
    supplies: ["fullyQualifiedNamespace", "groupName"],
  }),
);
