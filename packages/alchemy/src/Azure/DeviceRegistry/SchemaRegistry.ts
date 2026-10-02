import * as deviceregistry from "@distilled.cloud/azure/deviceregistry";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import {
  desiredTags,
  ensureRegistered,
  hasAnyAlchemyTag,
  ignoreNotFound,
  isOwned,
  orUndefinedIfNotFound,
  requireSinglePage,
  resourceGroupOf,
  tagsDiffer,
  userTags,
  waitForProvisioned,
  waitUntilGone,
} from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import {
  DEVICE_REGISTRY_RP,
  DEVICE_REGISTRY_WAIT,
  createDeviceRegistryName,
  sameLocation,
  sameName,
} from "./DeviceRegistryShared.ts";

export interface SchemaRegistryProps {
  /** Resource group the registry is created in. Changing it replaces the registry. */
  resourceGroup: string;
  /**
   * Registry name: 3-63 letters, digits, and hyphens. If omitted, a unique
   * name is generated from the app, stage, and logical ID. Changing it
   * replaces the registry.
   */
  name?: string;
  /**
   * Azure location of the registry. Changing it replaces the registry.
   * @default the `Azure.Location` layer, else the profile location, else `eastus`
   */
  location?: string;
  /**
   * Schema registry namespace; uniquely identifies the registry within the
   * tenant. 3-32 lowercase letters, digits, and hyphens. Changing it
   * replaces the registry.
   * @default a unique name generated from the app, stage, and logical ID
   */
  namespace?: string;
  /**
   * URL of the blob container that stores the schemas, e.g.
   * `https://{account}.blob.core.windows.net/{container}`. The registry's
   * managed identity needs `Storage Blob Data Contributor` on the container
   * to write schemas. Changing it replaces the registry.
   */
  storageAccountContainerUrl: string;
  /** Human-readable display name. */
  displayName?: string;
  /** Human-readable description. */
  description?: string;
  /**
   * Enable a system-assigned managed identity (used to write schemas to
   * the storage container).
   * @default true
   */
  systemAssignedIdentity?: boolean;
  /**
   * User tags. Alchemy ownership tags (`alchemy::stack`, `alchemy::stage`,
   * `alchemy::id`) are merged in automatically.
   */
  tags?: Record<string, string>;
}

export interface SchemaRegistry extends Resource<
  "Azure.DeviceRegistry.SchemaRegistry",
  SchemaRegistryProps,
  {
    /** Name of the schema registry. */
    schemaRegistryName: string;
    /** ARM resource ID of the schema registry. */
    schemaRegistryId: string;
    /** Resource group that holds the registry. */
    resourceGroup: string;
    /** Location of the registry. */
    location: string;
    /** Schema registry namespace. */
    namespace: string;
    /** URL of the blob container that stores the schemas. */
    storageAccountContainerUrl: string;
    /** Globally unique, immutable ID Azure assigns to the registry. */
    uuid: string | undefined;
    /** Principal ID of the system-assigned identity (empty when disabled). */
    principalId: string;
    /** Human-readable display name. */
    displayName: string | undefined;
    /** Human-readable description. */
    description: string | undefined;
    /** User tags (Alchemy ownership tags stripped). */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * An Azure Device Registry schema registry — a store of message schemas
 * (JSON Schema or Delta) used by Azure IoT Operations data flows. Schemas
 * are persisted in a blob container the registry writes to with its
 * managed identity.
 *
 * @see https://learn.microsoft.com/azure/iot-operations/connect-to-cloud/concept-schema-registry
 *
 * ### Creating a Schema Registry
 * **Example:** Registry backed by a blob container
 * ```typescript
 * const account = yield* Azure.Storage.StorageAccount("schemas", {
 *   resourceGroup: group.resourceGroupName,
 * });
 * const container = yield* Azure.Storage.BlobContainer("schemas", {
 *   resourceGroup: group.resourceGroupName,
 *   storageAccount: account.storageAccountName,
 * });
 * const registry = yield* Azure.DeviceRegistry.SchemaRegistry("registry", {
 *   resourceGroup: group.resourceGroupName,
 *   storageAccountContainerUrl: Output.interpolate`${account.primaryEndpoints.blob}${container.containerName}`,
 *   description: "Message schemas for the plant floor",
 * });
 * ```
 *
 * ### Granting Storage Access
 * **Example:** Let the registry write schemas to the container
 * ```typescript
 * yield* Azure.Authorization.RoleAssignment("registry-blob", {
 *   scope: container.containerId,
 *   roleDefinitionId: Azure.Authorization.BuiltInRole.StorageBlobDataContributor,
 *   principalId: registry.principalId,
 *   principalType: "ServicePrincipal",
 * });
 * ```
 *
 * @resource
 */
export const SchemaRegistry = Resource<SchemaRegistry>(
  "Azure.DeviceRegistry.SchemaRegistry",
);

const getRegistry = (
  subscriptionId: string,
  resourceGroupName: string,
  schemaRegistryName: string,
) =>
  orUndefinedIfNotFound(
    deviceregistry.GetSchemaRegistry({
      subscriptionId,
      resourceGroupName,
      schemaRegistryName,
    }),
  );

const toAttrs = (
  resourceGroup: string,
  name: string,
  observed: deviceregistry.GetSchemaRegistryResponse,
): SchemaRegistry["Attributes"] => ({
  schemaRegistryName: name,
  schemaRegistryId: observed.id ?? "",
  resourceGroup,
  location: observed.location,
  namespace: observed.properties?.namespace ?? "",
  storageAccountContainerUrl:
    observed.properties?.storageAccountContainerUrl ?? "",
  uuid: observed.properties?.uuid,
  principalId: observed.identity?.principalId ?? "",
  displayName: observed.properties?.displayName,
  description: observed.properties?.description,
  tags: userTags(observed.tags),
});

const trimSlash = (url: string) => url.replace(/\/+$/, "");

export const SchemaRegistryProvider = () =>
  Provider.succeed(SchemaRegistry, {
    stables: [
      "schemaRegistryName",
      "schemaRegistryId",
      "resourceGroup",
      "location",
      "namespace",
      "storageAccountContainerUrl",
      "uuid",
    ],

    list: Effect.fn(function* () {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const page = yield* orUndefinedIfNotFound(
        deviceregistry
          .ListSchemaRegistryBySubscription({ subscriptionId })
          .pipe(
            Effect.flatMap((page) =>
              requireSinglePage("ListSchemaRegistryBySubscription", page),
            ),
          ),
      );
      return (page?.value ?? []).flatMap((registry) => {
        const group = resourceGroupOf(registry.id);
        return hasAnyAlchemyTag(registry.tags) &&
          group !== undefined &&
          registry.name !== undefined
          ? [toAttrs(group, registry.name, registry)]
          : [];
      });
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        !sameName(news.resourceGroup, output.resourceGroup) ||
        (news.name !== undefined &&
          !sameName(news.name, output.schemaRegistryName)) ||
        (news.location !== undefined &&
          !sameLocation(news.location, output.location)) ||
        (news.namespace !== undefined &&
          news.namespace !== output.namespace) ||
        trimSlash(news.storageAccountContainerUrl).toLowerCase() !==
          trimSlash(output.storageAccountContainerUrl).toLowerCase()
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      if (resourceGroup === undefined) return undefined;
      const name =
        output?.schemaRegistryName ??
        olds?.name ??
        (yield* createDeviceRegistryName(id));
      const observed = yield* getRegistry(subscriptionId, resourceGroup, name);
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, name, observed);
      return (yield* isOwned(id, observed.tags)) ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* AzureEnvironment.current;
      const { subscriptionId } = env;
      yield* ensureRegistered(subscriptionId, DEVICE_REGISTRY_RP);
      const resourceGroup = news.resourceGroup;
      const name =
        news.name ??
        output?.schemaRegistryName ??
        (yield* createDeviceRegistryName(id));
      const location = news.location ?? output?.location ?? env.location;
      const tags = yield* desiredTags(id, news.tags);
      const identityType =
        (news.systemAssignedIdentity ?? true) ? "SystemAssigned" : "None";
      const where = {
        subscriptionId,
        resourceGroupName: resourceGroup,
        schemaRegistryName: name,
      };
      const get = getRegistry(subscriptionId, resourceGroup, name);
      const label = `schema registry ${name}`;
      const state = (r: deviceregistry.GetSchemaRegistryResponse) =>
        r.properties?.provisioningState;

      // Observe.
      let observed = yield* get;

      // Ensure.
      if (observed === undefined) {
        yield* deviceregistry.SchemaRegistriesCreateOrReplace({
          ...where,
          location,
          tags,
          identity: { type: identityType },
          properties: {
            namespace:
              news.namespace ?? (yield* createDeviceRegistryName(id, 32)),
            storageAccountContainerUrl: news.storageAccountContainerUrl,
            displayName: news.displayName,
            description: news.description,
          },
        });
      }
      observed = yield* waitForProvisioned(
        label,
        get,
        state,
        DEVICE_REGISTRY_WAIT,
      );

      // Sync display name, description, identity, and tags.
      const props = observed.properties;
      const properties: deviceregistry.SchemaRegistryUpdateProperties = {};
      if (
        news.displayName !== undefined &&
        props?.displayName !== news.displayName
      ) {
        properties.displayName = news.displayName;
      }
      if (
        news.description !== undefined &&
        props?.description !== news.description
      ) {
        properties.description = news.description;
      }
      const identityChanged =
        (observed.identity?.type ?? "None") !== identityType;
      const tagsChanged = tagsDiffer(observed.tags, tags);
      const propertiesChanged = Object.keys(properties).length > 0;
      if (propertiesChanged || identityChanged || tagsChanged) {
        yield* deviceregistry.UpdateSchemaRegistry({
          ...where,
          identity: identityChanged ? { type: identityType } : undefined,
          tags: tagsChanged ? tags : undefined,
          properties: propertiesChanged ? properties : undefined,
        });
        observed = yield* waitForProvisioned(
          label,
          get,
          state,
          DEVICE_REGISTRY_WAIT,
        );
      }

      return toAttrs(resourceGroup, name, observed);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        deviceregistry.DeleteSchemaRegistry({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          schemaRegistryName: output.schemaRegistryName,
        }),
      );
      yield* waitUntilGone(
        `schema registry ${output.schemaRegistryName}`,
        getRegistry(
          subscriptionId,
          output.resourceGroup,
          output.schemaRegistryName,
        ),
        DEVICE_REGISTRY_WAIT,
      );
    }),

    nuke: { dependsOn: ["Azure.Resources.ResourceGroup"] },
  });
