import * as digitaltwins from "@distilled.cloud/azure/digitaltwins";
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
  requireSinglePage,
  resourceGroupOf,
  tagsDiffer,
  userTags,
  waitForProvisioned,
  waitUntilGone,
} from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import { createInstanceName, getInstance } from "./Common.ts";

export type InstanceIdentityType =
  | "None"
  | "SystemAssigned"
  | "UserAssigned"
  | "SystemAssigned,UserAssigned";

export interface InstanceIdentity {
  /** Kind of managed identity the instance uses. */
  type: InstanceIdentityType;
  /**
   * ARM resource IDs of user-assigned identities to attach (with
   * `UserAssigned` or `SystemAssigned,UserAssigned`).
   */
  userAssignedIdentities?: string[];
}

export interface InstanceProps {
  /** Resource group the instance is created in. Changing it replaces the instance. */
  resourceGroup: string;
  /**
   * Instance name: 3-63 letters, digits, and hyphens, starting and ending
   * with a letter or digit. It becomes the globally unique data-plane host
   * name. If omitted, a unique name is generated from the app, stage, and
   * logical ID. Changing it replaces the instance.
   */
  name?: string;
  /**
   * Azure location of the instance. Changing it replaces the instance.
   * @default the `Azure.Location` layer, else the profile location, else `eastus`
   */
  location?: string;
  /**
   * Managed identity of the instance, used by identity-based endpoints and
   * time series database connections.
   * @default no identity
   */
  identity?: InstanceIdentity;
  /**
   * Whether the data plane is reachable from public networks.
   * @default "Enabled"
   */
  publicNetworkAccess?: "Enabled" | "Disabled";
  /**
   * User tags. Alchemy ownership tags (`alchemy::stack`, `alchemy::stage`,
   * `alchemy::id`) are merged in automatically.
   */
  tags?: Record<string, string>;
}

export interface Instance extends Resource<
  "Azure.DigitalTwins.Instance",
  InstanceProps,
  {
    /** Name of the instance. */
    instanceName: string;
    /** Resource group that holds the instance. */
    resourceGroup: string;
    /** ARM resource ID of the instance; use it as a role-assignment scope. */
    instanceId: string;
    /** Location of the instance. */
    location: string;
    /** Data-plane host name; the API endpoint is `https://{hostName}`. */
    hostName: string | undefined;
    /** Identity type of the instance (`None` when it has none). */
    identityType: string;
    /** Object ID of the system-assigned identity, if any. */
    principalId: string | undefined;
    /** Tenant of the system-assigned identity, if any. */
    tenantId: string | undefined;
    /** Public network access setting. */
    publicNetworkAccess: string;
    /** Provisioning state reported by Azure. */
    provisioningState: string | undefined;
    /** Time the instance was created. */
    createdTime: string | undefined;
    /** User tags (Alchemy ownership tags stripped). */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * An Azure Digital Twins instance — a live graph of digital twins of
 * physical environments, queried and updated through its data-plane API.
 * There is no hourly fee: Digital Twins bills per operation, query, and
 * message.
 *
 * Data-plane access needs the `Azure Digital Twins Data Owner` (or Reader)
 * role on the instance.
 *
 * @see https://learn.microsoft.com/azure/digital-twins/overview
 *
 * ### Creating an Instance
 * **Example:** Instance with a system-assigned identity
 * ```typescript
 * const group = yield* Azure.Resources.ResourceGroup("twins");
 * const twins = yield* Azure.DigitalTwins.Instance("factory", {
 *   resourceGroup: group.resourceGroupName,
 *   identity: { type: "SystemAssigned" },
 * });
 * ```
 *
 * **Example:** Private instance
 * ```typescript
 * const twins = yield* Azure.DigitalTwins.Instance("factory", {
 *   resourceGroup: group.resourceGroupName,
 *   publicNetworkAccess: "Disabled",
 * });
 * ```
 *
 * ### Granting Data-Plane Access
 * **Example:** Let an identity manage twins
 * ```typescript
 * yield* Azure.Authorization.RoleAssignment("api-owns-twins", {
 *   scope: twins.instanceId,
 *   // Azure Digital Twins Data Owner
 *   roleDefinitionId: "bcd981a7-7f74-457b-83e1-cceb9e632ffe",
 *   principalId: identity.principalId,
 *   principalType: "ServicePrincipal",
 * });
 * ```
 *
 * @resource
 */
export const Instance = Resource<Instance>("Azure.DigitalTwins.Instance");

type ObservedInstance = digitaltwins.GetDigitalTwinResponse;

const toAttrs = (
  resourceGroup: string,
  name: string,
  observed: ObservedInstance,
): Instance["Attributes"] => ({
  instanceName: name,
  resourceGroup,
  instanceId: observed.id ?? "",
  location: observed.location,
  hostName: observed.properties?.hostName ?? undefined,
  identityType: observed.identity?.type ?? "None",
  principalId: observed.identity?.principalId ?? undefined,
  tenantId: observed.identity?.tenantId ?? undefined,
  publicNetworkAccess: observed.properties?.publicNetworkAccess ?? "Enabled",
  provisioningState: observed.properties?.provisioningState,
  createdTime: observed.properties?.createdTime,
  tags: userTags(observed.tags ?? undefined),
});

const desiredIdentity = (identity: InstanceIdentity | undefined) => {
  const type = identity?.type ?? "None";
  const ids = identity?.userAssignedIdentities ?? [];
  return {
    type,
    ...(ids.length > 0 && type.includes("UserAssigned")
      ? {
          userAssignedIdentities: Object.fromEntries(
            ids.map((uid) => [uid, {}]),
          ),
        }
      : {}),
  };
};

const identityDiffers = (
  observed: ObservedInstance["identity"],
  desired: ReturnType<typeof desiredIdentity>,
) => {
  if ((observed?.type ?? "None") !== desired.type) return true;
  const observedIds = Object.keys(observed?.userAssignedIdentities ?? {})
    .map((k) => k.toLowerCase())
    .sort();
  const desiredIds = Object.keys(desired.userAssignedIdentities ?? {})
    .map((k) => k.toLowerCase())
    .sort();
  return observedIds.join("|") !== desiredIds.join("|");
};

export const InstanceProvider = () =>
  Provider.succeed(Instance, {
    stables: ["instanceName", "resourceGroup", "instanceId", "location"],

    list: Effect.fn(function* () {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const page = yield* digitaltwins
        .ListDigitalTwins({ subscriptionId })
        .pipe(
          Effect.flatMap((page) =>
            requireSinglePage("ListDigitalTwins", {
              ...page,
              nextLink: page.nextLink ?? undefined,
            }),
          ),
        );
      return (page.value ?? []).flatMap((instance) => {
        const group = resourceGroupOf(instance.id);
        return hasAnyAlchemyTag(instance.tags ?? undefined) &&
          group !== undefined &&
          instance.name !== undefined
          ? [toAttrs(group, instance.name, instance)]
          : [];
      });
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        news.resourceGroup.toLowerCase() !==
          output.resourceGroup.toLowerCase() ||
        (news.name !== undefined &&
          news.name.toLowerCase() !== output.instanceName.toLowerCase()) ||
        (news.location !== undefined &&
          news.location.toLowerCase().replace(/\s/g, "") !==
            output.location.toLowerCase().replace(/\s/g, ""))
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
        output?.instanceName ?? olds?.name ?? (yield* createInstanceName(id));
      const observed = yield* getInstance(subscriptionId, resourceGroup, name);
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, name, observed);
      return (yield* isOwned(id, observed.tags ?? undefined))
        ? attrs
        : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* AzureEnvironment.current;
      const { subscriptionId } = env;
      yield* ensureRegistered(subscriptionId, "Microsoft.DigitalTwins");
      const resourceGroup = news.resourceGroup;
      const name =
        news.name ?? output?.instanceName ?? (yield* createInstanceName(id));
      const location = news.location ?? output?.location ?? env.location;
      const tags = yield* desiredTags(id, news.tags);
      const identity = desiredIdentity(news.identity);
      const publicNetworkAccess = news.publicNetworkAccess ?? "Enabled";
      const where = {
        subscriptionId,
        resourceGroupName: resourceGroup,
        resourceName: name,
      };
      const get = getInstance(subscriptionId, resourceGroup, name);
      const settle = waitForProvisioned(
        `digital twins instance ${name}`,
        get,
        (instance) => instance.properties?.provisioningState,
        { interval: "5 seconds", times: 72 },
      );

      // Observe.
      let observed = yield* get;

      // A previous operation may still be running; let it finish first. A
      // deleting instance keeps its name reserved until it is gone.
      if (observed?.properties?.provisioningState === "Deleting") {
        yield* waitUntilGone(`digital twins instance ${name}`, get, {
          interval: "5 seconds",
          times: 72,
        });
        observed = undefined;
      } else if (
        observed !== undefined &&
        observed.properties?.provisioningState !== "Succeeded"
      ) {
        observed = yield* settle;
      }

      // Ensure.
      if (observed === undefined) {
        yield* digitaltwins.DigitalTwinsCreateOrUpdate({
          ...where,
          location,
          tags,
          identity,
          properties: { publicNetworkAccess },
        });
        observed = yield* settle;
      }

      // Sync identity, public network access, and tags against the
      // observed instance with one PATCH carrying only the deltas.
      const patch: Omit<
        digitaltwins.UpdateDigitalTwinRequest,
        keyof typeof where
      > = {};
      if (identityDiffers(observed.identity, identity)) {
        patch.identity = identity;
      }
      if (
        (observed.properties?.publicNetworkAccess ?? "Enabled") !==
        publicNetworkAccess
      ) {
        patch.properties = { publicNetworkAccess };
      }
      if (tagsDiffer(observed.tags ?? undefined, tags)) {
        patch.tags = tags;
      }
      if (Object.keys(patch).length > 0) {
        yield* digitaltwins.UpdateDigitalTwin({ ...where, ...patch });
        observed = yield* settle;
      }

      return toAttrs(resourceGroup, name, observed);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        digitaltwins.DeleteDigitalTwin({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          resourceName: output.instanceName,
        }),
      );
      yield* waitUntilGone(
        `digital twins instance ${output.instanceName}`,
        getInstance(subscriptionId, output.resourceGroup, output.instanceName),
        { interval: "5 seconds", times: 72 },
      );
    }),

    nuke: { dependsOn: ["Azure.Resources.ResourceGroup"] },
  });
