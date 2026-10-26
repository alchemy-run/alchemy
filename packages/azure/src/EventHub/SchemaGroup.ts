import * as eventhub from "@distilled.cloud/azure/eventhub";
import { Unowned } from "alchemy/AdoptPolicy";
import { isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import type { Resource } from "alchemy/Resource";
import { tagRecord } from "alchemy/Tags";
import * as Effect from "effect/Effect";
import {
  ensureRegistered,
  ignoreNotFound,
  orUndefinedIfNotFound,
  tagsDiffer,
  waitForProvisioned,
  waitUntilGone,
} from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import { GroupedResource } from "../StackResourceGroup.ts";
import { createEntityName, namespaceOwnedByStage } from "./Common.ts";

/** Serialization format of the schemas in a group. */
export type SchemaType = "Avro" | "Json" | "ProtoBuf" | "Unknown";
/**
 * Rule a new schema version must pass: `None` (no check), `Backward` (new
 * readers can read old data), or `Forward` (old readers can read new data).
 */
export type SchemaCompatibility = "None" | "Backward" | "Forward";

export interface SchemaGroupProps {
  /**
   * Resource group of the namespace.
   *
   * :::caution
   * Changing it replaces the schema group and deletes its schemas.
   * :::
   * @default the stack's resource group (`Azure.resourceGroup(...)`, else `<stack>-<stage>`)
   */
  resourceGroup: string;
  /**
   * Name of the `Standard` (or higher) namespace that hosts the schema
   * registry, e.g. `namespace.namespaceName`.
   *
   * :::caution
   * Changing it replaces the schema group and deletes its schemas.
   * :::
   */
  namespace: string;
  /**
   * Schema group name, up to 50 characters: letters, digits, periods,
   * hyphens, and underscores, starting and ending with a letter or digit.
   *
   * :::caution
   * Changing it replaces the schema group and deletes its schemas.
   * :::
   * @default a name generated from the app, stage, and logical ID
   */
  name?: string;
  /**
   * Serialization format of every schema in the group.
   *
   * :::caution
   * Changing it replaces the schema group and deletes its schemas.
   * :::
   * @default "Avro"
   */
  schemaType?: SchemaType;
  /**
   * Compatibility rule enforced when a new schema version is registered.
   * `Json` groups accept only `None`. Azure cannot change it on an existing
   * group.
   *
   * :::caution
   * Changing it replaces the schema group and deletes its schemas.
   * :::
   * @default "None"
   */
  schemaCompatibility?: SchemaCompatibility;
  /**
   * Free-form string properties attached to the group. Changes apply in
   * place.
   * @default {}
   */
  groupProperties?: Record<string, string>;
}

export interface SchemaGroup extends Resource<
  "Azure.EventHub.SchemaGroup",
  SchemaGroupProps,
  {
    /** Name of the schema group. */
    schemaGroupName: string;
    /** ARM resource ID of the schema group. */
    schemaGroupId: string;
    /** Namespace that hosts the schema registry. */
    namespace: string;
    /** Resource group of the namespace. */
    resourceGroup: string;
    /** Serialization format (`Avro`, `Json`, `ProtoBuf`, `Unknown`). */
    schemaType: string | undefined;
    /** Compatibility rule (`None`, `Backward`, `Forward`). */
    schemaCompatibility: string | undefined;
    /** Group properties. */
    groupProperties: Record<string, string>;
    /** ETag of the schema group. */
    eTag: string | undefined;
  },
  never,
  Providers
> {}

/**
 * A schema group in the Event Hubs schema registry
 * (`Microsoft.EventHub/namespaces/schemagroups`): a named collection of
 * versioned schemas that share one format and compatibility rule.
 * Producers register schemas in it and stamp the schema ID on each event;
 * consumers read the schema back by ID. The schemas themselves are
 * data-plane objects: register and read them with the
 * `Azure.EventHub.SchemaGroupReadWrite` binding.
 *
 * Schema groups have no tags. Alchemy treats a group as owned when its
 * namespace carries this stack's ownership tags.
 *
 * :::caution[Changing `name`, `namespace`, `schemaType`, `schemaCompatibility`, or `resourceGroup` replaces the group]
 * Alchemy deletes the old group with every schema in it first (a
 * `Standard` namespace holds one schema group), then creates the new one.
 * Producers must register their schemas again, and the old schema IDs stop
 * resolving.
 * :::
 *
 * :::caution[Needs a `Standard` (or higher) namespace]
 * A `Basic` namespace has no schema registry. A `Standard` namespace
 * allows one schema group.
 * :::
 *
 * @see https://learn.microsoft.com/azure/event-hubs/schema-registry-overview
 *
 * ### Creating a Schema Group
 * **Example:** Avro schemas with backward compatibility
 * ```typescript
 * const namespace = yield* Azure.EventHub.Namespace("events", {
 *   sku: "Standard",
 * });
 * const schemas = yield* Azure.EventHub.SchemaGroup("orders-schemas", {
 *   namespace: namespace.namespaceName,
 *   schemaType: "Avro",
 *   schemaCompatibility: "Backward",
 * });
 * ```
 *
 * ### Using the Registry from a Runtime
 * Bind the group to a host to register and read schemas.
 *
 * **Example:** Register a schema, then read it by ID
 * ```typescript
 * // Schemas: the SchemaGroup above, declared at module scope
 * const orderSchema = {
 *   type: "record",
 *   name: "Order",
 *   fields: [{ name: "id", type: "string" }],
 * };
 *
 * export default class Producer extends Azure.Functions.Function<Producer>()(
 *   "Producer",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     const group = yield* Schemas;
 *     // init: assigns Schema Registry Reader on the group and the
 *     // schemas/write role on its namespace
 *     const registry = yield* Azure.EventHub.SchemaGroupReadWrite(group);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         // runtime
 *         const { id } = yield* registry.registerSchema("Order", JSON.stringify(orderSchema));
 *         const schema = yield* registry.getSchema(id);
 *         return yield* HttpServerResponse.json({ id, version: schema.version });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Azure.EventHub.SchemaGroupReadWriteHttp)),
 * ) {}
 * ```
 *
 * @resource
 */
export const SchemaGroup = GroupedResource<SchemaGroup>("Azure.EventHub.SchemaGroup");

const getSchemaGroup = (
  subscriptionId: string,
  resourceGroupName: string,
  namespaceName: string,
  schemaGroupName: string,
) =>
  orUndefinedIfNotFound(
    eventhub.GetSchemaRegistry({
      subscriptionId,
      resourceGroupName,
      namespaceName,
      schemaGroupName,
    }),
  );

const toAttrs = (
  resourceGroup: string,
  namespace: string,
  name: string,
  group: eventhub.GetSchemaRegistryResponse,
): SchemaGroup["Attributes"] => ({
  schemaGroupName: name,
  schemaGroupId: group.id ?? "",
  namespace,
  resourceGroup,
  schemaType: group.properties?.schemaType,
  schemaCompatibility: group.properties?.schemaCompatibility,
  groupProperties: tagRecord(group.properties?.groupProperties),
  eTag: group.properties?.eTag,
});

export const SchemaGroupProvider = () =>
  Provider.succeed(SchemaGroup, {
    stables: ["schemaGroupName", "schemaGroupId", "namespace", "resourceGroup"],

    // Schema groups live inside a namespace; nuke removes them with it.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        news.resourceGroup.toLowerCase() !== output.resourceGroup.toLowerCase() ||
        news.namespace.toLowerCase() !== output.namespace.toLowerCase() ||
        (news.name !== undefined &&
          news.name.toLowerCase() !== output.schemaGroupName.toLowerCase()) ||
        (news.schemaType ?? "Avro") !== (output.schemaType ?? "Avro") ||
        (news.schemaCompatibility ?? "None") !== (output.schemaCompatibility ?? "None")
      ) {
        // Standard namespaces allow a single schema group, so the old group
        // must go before its replacement can be created.
        return { action: "replace", deleteFirst: true } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      const namespace = output?.namespace ?? olds?.namespace;
      // An interrupted create can persist props with unresolved holes;
      // nothing can exist without its namespace.
      if (resourceGroup === undefined || namespace === undefined) {
        return undefined;
      }
      const name = output?.schemaGroupName ?? olds?.name ?? (yield* createEntityName(id, 50));
      const observed = yield* getSchemaGroup(subscriptionId, resourceGroup, namespace, name);
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, namespace, name, observed);
      return (yield* namespaceOwnedByStage(subscriptionId, resourceGroup, namespace))
        ? attrs
        : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, "Microsoft.EventHub");
      const { resourceGroup, namespace } = news;
      const name = news.name ?? output?.schemaGroupName ?? (yield* createEntityName(id, 50));
      const schemaType = news.schemaType ?? "Avro";
      const schemaCompatibility = news.schemaCompatibility ?? "None";
      const groupProperties = news.groupProperties ?? {};
      const get = getSchemaGroup(subscriptionId, resourceGroup, namespace, name);

      // Observe.
      const observed = yield* get;
      const current = observed?.properties;

      // Ensure + sync group properties (the only mutable aspect; type and
      // compatibility replace the group). The PUT is a synchronous upsert.
      if (current === undefined || tagsDiffer(current.groupProperties, groupProperties)) {
        yield* eventhub.SchemaRegistryCreateOrUpdate({
          subscriptionId,
          resourceGroupName: resourceGroup,
          namespaceName: namespace,
          schemaGroupName: name,
          properties: {
            schemaType: current?.schemaType ?? schemaType,
            schemaCompatibility: current?.schemaCompatibility ?? schemaCompatibility,
            groupProperties,
          },
        });
      }

      const fresh = yield* waitForProvisioned(`schema group ${name}`, get, () => undefined, {
        interval: "2 seconds",
        times: 15,
      });
      return toAttrs(resourceGroup, namespace, name, fresh);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        eventhub.DeleteSchemaRegistry({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          namespaceName: output.namespace,
          schemaGroupName: output.schemaGroupName,
        }),
      );
      yield* waitUntilGone(
        `schema group ${output.schemaGroupName}`,
        getSchemaGroup(
          subscriptionId,
          output.resourceGroup,
          output.namespace,
          output.schemaGroupName,
        ),
      );
    }),

    nuke: {
      dependsOn: ["Azure.EventHub.Namespace", "Azure.Resources.ResourceGroup"],
    },
  });
