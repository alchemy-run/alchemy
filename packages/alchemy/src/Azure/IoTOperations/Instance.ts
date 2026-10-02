import * as iot from "@distilled.cloud/azure/iotoperations";
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
  createIotName,
  getInstance,
  IOT_OPERATIONS_NAMESPACE,
  isSubset,
  sameId,
} from "./Common.ts";

/** A feature of an IoT Operations instance. */
export interface InstanceFeature {
  /** Lifecycle mode of the feature. */
  mode?: "Stable" | "Preview" | "Disabled";
  /** Feature settings, each `Enabled` or `Disabled`. */
  settings?: Record<string, "Enabled" | "Disabled">;
}

/** Managed identity of an IoT Operations instance. */
export interface InstanceIdentity {
  /** Identity type. */
  type:
    | "None"
    | "SystemAssigned"
    | "UserAssigned"
    | "SystemAssigned,UserAssigned";
  /** ARM IDs of user-assigned identities to attach. */
  userAssignedIdentities?: string[];
}

export interface InstanceProps {
  /** Resource group the instance is created in. Changing it replaces the instance. */
  resourceGroup: string;
  /**
   * Instance name: 3-63 lowercase letters, digits, and hyphens. If omitted,
   * a unique name is generated from the app, stage, and logical ID.
   * Changing it replaces the instance.
   */
  name?: string;
  /**
   * Azure region of the instance; must match the custom location's region.
   * Changing it replaces the instance.
   * @default the `Azure.Location` layer, else the profile location, else `eastus`
   */
  location?: string;
  /**
   * ARM ID of the Arc custom location (`Microsoft.ExtendedLocation/customLocations`)
   * bound to the cluster's `microsoft.iotoperations` extension. Changing it
   * replaces the instance.
   */
  customLocationId: string;
  /**
   * ARM ID of the Azure Device Registry schema registry
   * (`Microsoft.DeviceRegistry/schemaRegistries`). Changing it replaces the
   * instance.
   */
  schemaRegistryId: string;
  /**
   * ARM ID of the Azure Device Registry namespace used by assets and
   * devices. Changing it replaces the instance.
   */
  adrNamespaceId?: string;
  /**
   * ARM ID of the default secret provider class
   * (`Microsoft.SecretSyncController/azureKeyVaultSecretProviderClasses`).
   */
  defaultSecretProviderClassId?: string;
  /** Feature flags of the instance, keyed by feature name. */
  features?: Record<string, InstanceFeature>;
  /** Description of the instance. */
  description?: string;
  /** Managed identity of the instance. */
  identity?: InstanceIdentity;
  /**
   * User tags. Alchemy ownership tags (`alchemy::stack`, `alchemy::stage`,
   * `alchemy::id`) are merged in automatically.
   */
  tags?: Record<string, string>;
}

export interface Instance extends Resource<
  "Azure.IoTOperations.Instance",
  InstanceProps,
  {
    /** Name of the instance. */
    instanceName: string;
    /** Resource group that holds the instance. */
    resourceGroup: string;
    /** ARM resource ID of the instance. */
    instanceId: string;
    /** Azure region of the instance. */
    location: string;
    /** ARM ID of the Arc custom location that hosts the instance. */
    customLocationId: string;
    /** Azure IoT Operations version running on the cluster. */
    version: string | undefined;
    /** Provisioning state of the instance. */
    provisioningState: string | undefined;
    /** Health of the instance as reported by the edge cluster. */
    healthState: string | undefined;
    /** Principal ID of the system-assigned identity, if any. */
    principalId: string | undefined;
    /** User tags (Alchemy ownership tags stripped). */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * An Azure IoT Operations instance: the root of the edge MQTT broker,
 * dataflows, and connectors deployed on an Azure Arc-enabled Kubernetes
 * cluster.
 *
 * The cluster, its IoT Operations / secret store / cert-manager
 * extensions, the custom location, and the Azure Device Registry schema
 * registry are prerequisites created outside this resource (for example
 * with `az iot ops init`).
 *
 * @see https://learn.microsoft.com/azure/iot-operations/overview-iot-operations
 *
 * ### Creating an Instance
 * **Example:** Instance on an Arc-enabled cluster
 * ```typescript
 * const instance = yield* Azure.IoTOperations.Instance("aio", {
 *   resourceGroup: group.resourceGroupName,
 *   customLocationId,
 *   schemaRegistryId,
 * });
 * ```
 *
 * **Example:** Instance with a description and a system-assigned identity
 * ```typescript
 * const instance = yield* Azure.IoTOperations.Instance("aio", {
 *   resourceGroup: group.resourceGroupName,
 *   customLocationId,
 *   schemaRegistryId,
 *   description: "factory floor",
 *   identity: { type: "SystemAssigned" },
 *   tags: { env: "prod" },
 * });
 * ```
 *
 * @resource
 */
export const Instance = Resource<Instance>("Azure.IoTOperations.Instance");

const toAttrs = (
  resourceGroup: string,
  name: string,
  value: iot.GetInstanceResponse,
): Instance["Attributes"] => ({
  instanceName: name,
  resourceGroup,
  instanceId: value.id ?? "",
  location: value.location,
  customLocationId: value.extendedLocation.name,
  version: value.properties?.version,
  provisioningState: value.properties?.provisioningState,
  healthState: value.properties?.healthState,
  principalId: value.identity?.principalId,
  tags: userTags(value.tags),
});

const toIdentity = (identity: InstanceIdentity | undefined) =>
  identity === undefined
    ? undefined
    : {
        type: identity.type,
        ...(identity.userAssignedIdentities?.length
          ? {
              userAssignedIdentities: Object.fromEntries(
                identity.userAssignedIdentities.map((id) => [id, {}]),
              ),
            }
          : {}),
      };

const identityInSync = (
  desired: InstanceIdentity | undefined,
  observed: iot.GetInstanceResponseIdentity | undefined,
) => {
  if (desired === undefined) return true;
  const observedType = observed?.type ?? "None";
  if (
    !sameId(desired.type.replaceAll(" ", ""), observedType.replaceAll(" ", ""))
  ) {
    return false;
  }
  const want = (desired.userAssignedIdentities ?? []).map((id) =>
    id.toLowerCase(),
  );
  const have = Object.keys(observed?.userAssignedIdentities ?? {}).map((id) =>
    id.toLowerCase(),
  );
  return want.length === have.length && want.every((id) => have.includes(id));
};

const propertiesOf = (props: InstanceProps): iot.InstancePropertiesInput => ({
  schemaRegistryRef: { resourceId: props.schemaRegistryId },
  ...(props.description !== undefined
    ? { description: props.description }
    : {}),
  ...(props.defaultSecretProviderClassId !== undefined
    ? {
        defaultSecretProviderClassRef: {
          resourceId: props.defaultSecretProviderClassId,
        },
      }
    : {}),
  ...(props.features !== undefined ? { features: props.features } : {}),
  ...(props.adrNamespaceId !== undefined
    ? { adrNamespaceRef: { resourceId: props.adrNamespaceId } }
    : {}),
});

/** Whether the observed mutable properties match the desired ones. */
const propertiesInSync = (
  props: InstanceProps,
  observed: iot.InstanceProperties | undefined,
) =>
  (props.description === undefined ||
    props.description === observed?.description) &&
  (props.defaultSecretProviderClassId === undefined ||
    sameId(
      props.defaultSecretProviderClassId,
      observed?.defaultSecretProviderClassRef?.resourceId,
    )) &&
  isSubset(props.features, observed?.features);

export const InstanceProvider = () =>
  Provider.succeed(Instance, {
    stables: [
      "instanceName",
      "resourceGroup",
      "instanceId",
      "location",
      "customLocationId",
    ],

    list: Effect.fn(function* () {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const page = yield* orUndefinedIfNotFound(
        iot
          .ListInstanceBySubscription({ subscriptionId })
          .pipe(
            Effect.flatMap((page) =>
              requireSinglePage("ListInstanceBySubscription", page),
            ),
          ),
      );
      return (page?.value ?? []).flatMap((value) => {
        const group = resourceGroupOf(value.id);
        return hasAnyAlchemyTag(value.tags) &&
          group !== undefined &&
          value.name !== undefined
          ? [toAttrs(group, value.name, value)]
          : [];
      });
    }),

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        !sameId(news.resourceGroup, output.resourceGroup) ||
        (news.name !== undefined && !sameId(news.name, output.instanceName)) ||
        (news.location !== undefined &&
          !sameId(news.location, output.location)) ||
        !sameId(news.customLocationId, output.customLocationId) ||
        (olds !== undefined &&
          (!sameId(news.schemaRegistryId, olds.schemaRegistryId) ||
            !sameId(news.adrNamespaceId, olds.adrNamespaceId)))
      ) {
        // An explicit name is reused by the replacement, so the old one
        // must go first; generated names differ per instance.
        return {
          action: "replace",
          deleteFirst: news.name !== undefined,
        } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      if (resourceGroup === undefined) return undefined;
      const name =
        output?.instanceName ?? olds?.name ?? (yield* createIotName(id));
      const observed = yield* getInstance(subscriptionId, resourceGroup, name);
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, name, observed);
      return (yield* isOwned(id, observed.tags)) ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* AzureEnvironment.current;
      const { subscriptionId } = env;
      yield* ensureRegistered(subscriptionId, IOT_OPERATIONS_NAMESPACE);
      const resourceGroup = news.resourceGroup;
      const name =
        news.name ?? output?.instanceName ?? (yield* createIotName(id));
      const location = news.location ?? output?.location ?? env.location;
      const tags = yield* desiredTags(id, news.tags);
      const identity = toIdentity(news.identity);
      const where = {
        subscriptionId,
        resourceGroupName: resourceGroup,
        instanceName: name,
      };
      const get = getInstance(subscriptionId, resourceGroup, name);
      // Instance provisioning installs the edge workloads; allow 15 minutes.
      const settle = waitForProvisioned(
        `IoT Operations instance ${name}`,
        get,
        (value) => value.properties?.provisioningState,
        { interval: "10 seconds", times: 90 },
      );

      // Observe.
      let observed = yield* get;

      // Ensure + sync properties: PUT is the only way to change the
      // instance's properties, so a full body is sent when the instance is
      // missing or its observed properties drift.
      if (
        observed === undefined ||
        !propertiesInSync(news, observed.properties)
      ) {
        yield* iot.InstanceCreateOrUpdate({
          ...where,
          location,
          tags,
          extendedLocation: {
            name: news.customLocationId,
            type: "CustomLocation",
          },
          properties: propertiesOf(news),
          ...(identity !== undefined ? { identity } : {}),
        });
        observed = yield* settle;
      }

      // Sync tags and identity against the observed instance (PATCH).
      if (
        tagsDiffer(observed.tags, tags) ||
        !identityInSync(news.identity, observed.identity)
      ) {
        yield* iot.UpdateInstance({
          ...where,
          tags,
          ...(identity !== undefined ? { identity } : {}),
        });
        observed = yield* settle;
      }

      return toAttrs(resourceGroup, name, observed);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      // Deleting the instance cascades to every child resource.
      yield* ignoreNotFound(
        iot.DeleteInstance({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          instanceName: output.instanceName,
        }),
      );
      yield* waitUntilGone(
        `IoT Operations instance ${output.instanceName}`,
        getInstance(subscriptionId, output.resourceGroup, output.instanceName),
        { interval: "10 seconds", times: 90 },
      );
    }),

    nuke: { dependsOn: ["Azure.Resources.ResourceGroup"] },
  });
