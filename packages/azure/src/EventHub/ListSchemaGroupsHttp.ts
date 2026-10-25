import * as Layer from "effect/Layer";
import { ListSchemaGroups } from "./ListSchemaGroups.ts";
import { makeListSchemaGroupsBinding } from "./SchemaRegistryBindingHttp.ts";

/**
 * Implementation of {@link ListSchemaGroups} over the distilled
 * `schemaregistry-data` data plane. Assigns **Schema Registry Reader** on
 * the namespace.
 *
 * @layer
 * @provides Azure.EventHub.ListSchemaGroups
 */
export const ListSchemaGroupsHttp = Layer.effect(
  ListSchemaGroups,
  makeListSchemaGroupsBinding("Azure.EventHub.ListSchemaGroups"),
);
