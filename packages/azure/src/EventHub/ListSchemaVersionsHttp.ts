import * as registry from "@distilled.cloud/azure/schemaregistry-data";
import * as Layer from "effect/Layer";
import { ListSchemaVersions } from "./ListSchemaVersions.ts";
import { makeSchemaGroupOperationBinding } from "./SchemaRegistryBindingHttp.ts";

/**
 * Implementation of {@link ListSchemaVersions} over the distilled `schemaregistry-data`
 * data plane. Assigns **Schema Registry Reader** on the schema group.
 *
 * @layer
 * @provides Azure.EventHub.ListSchemaVersions
 */
export const ListSchemaVersionsHttp = Layer.effect(
  ListSchemaVersions,
  makeSchemaGroupOperationBinding({
    tag: "Azure.EventHub.ListSchemaVersions",
    operation: registry.ListSchemaVersions,
    access: "read",
    supplies: ["fullyQualifiedNamespace", "groupName"],
  }),
);
