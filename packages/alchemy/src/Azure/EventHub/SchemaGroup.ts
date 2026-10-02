import * as eventhub from "@distilled.cloud/azure/eventhub";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { tagRecord } from "../../Tags.ts";
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
import { createEntityName, namespaceOwnedByStage } from "./Common.ts";

export type SchemaType = "Avro" | "Json" | "ProtoBuf" | "Unknown";
export type SchemaCompatibility = "None" | "Backward" | "Forward";

export interface SchemaGroupProps {
  /** Resource group of the namespace. Changing it replaces the schema group. */
  resourceGroup: string;
  /** Namespace that hosts the schema registry. Changing it replaces the schema group. */
  namespace: string;
  /**
   * Schema group name: letters, digits, periods, hyphens, and underscores.
   * If omitted, a unique name is generated from the app, stage, and logical
   * ID. Changing it replaces the schema group.
   */
  name?: string;
  /**
   * Serialization format of every schema in the group. Changing it replaces
   * the schema group.
   * @default "Avro"
   */
  schemaType?: SchemaType;
  /**
   * Compatibility rule enforced when a new schema version is registered.
   * Azure cannot change it on an existing group; changing it replaces the
   * schema group.
   * @default "None"
   */
  schemaCompatibility?: SchemaCompatibility;
  /** Free-form properties attached to the group. */
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
    /** Serialization format. */
    schemaType: string | undefined;
    /** Compatibility rule. */
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
 * A schema group in the Event Hubs schema registry — a named collection of
 * versioned schemas sharing one format and compatibility rule. Needs a
 * `Standard` (or higher) namespace; `Standard` allows one schema group per
 * namespace, so replacements delete the old group first. `Json` groups
 * only accept `schemaCompatibility: "None"`. The schemas themselves are
 * data-plane objects registered by producers.
 *
 * Schema groups have no tags; Alchemy treats a group as owned when its
 * namespace carries this stack's ownership tags.
 *
 * @see https://learn.microsoft.com/azure/event-hubs/schema-registry-overview
 *
 * ### Creating a Schema Group
 * **Example:** Avro schemas with backward compatibility
 * ```typescript
 * const schemas = yield* Azure.EventHub.SchemaGroup("orders-schemas", {
 *   resourceGroup: group.resourceGroupName,
 *   namespace: namespace.namespaceName,
 *   schemaType: "Avro",
 *   schemaCompatibility: "Backward",
 * });
 * ```
 *
 * @resource
 */
export const SchemaGroup = Resource<SchemaGroup>("Azure.EventHub.SchemaGroup");

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
        news.resourceGroup.toLowerCase() !==
          output.resourceGroup.toLowerCase() ||
        news.namespace.toLowerCase() !== output.namespace.toLowerCase() ||
        (news.name !== undefined &&
          news.name.toLowerCase() !== output.schemaGroupName.toLowerCase()) ||
        (news.schemaType ?? "Avro") !== (output.schemaType ?? "Avro") ||
        (news.schemaCompatibility ?? "None") !==
          (output.schemaCompatibility ?? "None")
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
      const name =
        output?.schemaGroupName ?? olds?.name ?? (yield* createEntityName(id, 50));
      const observed = yield* getSchemaGroup(
        subscriptionId,
        resourceGroup,
        namespace,
        name,
      );
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, namespace, name, observed);
      return (yield* namespaceOwnedByStage(
        subscriptionId,
        resourceGroup,
        namespace,
      ))
        ? attrs
        : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, "Microsoft.EventHub");
      const { resourceGroup, namespace } = news;
      const name =
        news.name ?? output?.schemaGroupName ?? (yield* createEntityName(id, 50));
      const schemaType = news.schemaType ?? "Avro";
      const schemaCompatibility = news.schemaCompatibility ?? "None";
      const groupProperties = news.groupProperties ?? {};
      const get = getSchemaGroup(subscriptionId, resourceGroup, namespace, name);

      // Observe.
      const observed = yield* get;
      const current = observed?.properties;

      // Ensure + sync group properties (the only mutable aspect; type and
      // compatibility replace the group). The PUT is a synchronous upsert.
      if (
        current === undefined ||
        tagsDiffer(current.groupProperties, groupProperties)
      ) {
        yield* eventhub.SchemaRegistryCreateOrUpdate({
          subscriptionId,
          resourceGroupName: resourceGroup,
          namespaceName: namespace,
          schemaGroupName: name,
          properties: {
            schemaType: current?.schemaType ?? schemaType,
            schemaCompatibility:
              current?.schemaCompatibility ?? schemaCompatibility,
            groupProperties,
          },
        });
      }

      const fresh = yield* waitForProvisioned(
        `schema group ${name}`,
        get,
        () => undefined,
        { interval: "2 seconds", times: 15 },
      );
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
