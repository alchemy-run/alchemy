import * as cs from "@distilled.cloud/azure/containerservice";
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
import {
  createChildName,
  getFleet,
  sameName,
  whileFleetBusy,
} from "./Common.ts";

export interface FleetHubProfile {
  /**
   * DNS prefix of the hub cluster's API server.
   * @default derived from the fleet name
   */
  dnsPrefix?: string;
  /** VM size of the hub's node. */
  agentVmSize?: string;
  /** Subnet of the hub's node. */
  agentSubnetId?: string;
  /** Make the hub API server private. */
  enablePrivateCluster?: boolean;
  /** Use API server VNet integration. */
  enableVnetIntegration?: boolean;
  /** Subnet for API server VNet integration. */
  apiServerSubnetId?: string;
}

export interface FleetProps {
  /** Resource group of the fleet. Changing it replaces the fleet. */
  resourceGroup: string;
  /**
   * Fleet name: 1-63 lowercase letters, digits, and hyphens. If omitted, a
   * unique name is generated from the app, stage, and logical ID. Changing
   * it replaces the fleet.
   */
  name?: string;
  /**
   * Azure location of the fleet. Changing it replaces the fleet.
   * @default the `Azure.Location` layer, else the profile location, else `eastus`
   */
  location?: string;
  /**
   * Hub cluster for Kubernetes resource propagation and managed
   * namespaces. A hub runs an AKS cluster billed per node. Omit it for a
   * hubless fleet (update orchestration only). Changing it replaces the
   * fleet.
   */
  hubProfile?: FleetHubProfile;
  /**
   * Give the fleet a system-assigned managed identity.
   * @default false
   */
  systemAssignedIdentity?: boolean;
  /** Resource IDs of user-assigned managed identities for the fleet. */
  userAssignedIdentityIds?: string[];
  /**
   * User tags. Alchemy ownership tags (`alchemy::stack`, `alchemy::stage`,
   * `alchemy::id`) are merged in automatically.
   */
  tags?: Record<string, string>;
}

export interface Fleet extends Resource<
  "Azure.ContainerService.Fleet",
  FleetProps,
  {
    /** Name of the fleet. */
    fleetName: string;
    /** ARM resource ID of the fleet. */
    fleetId: string;
    /** Resource group of the fleet. */
    resourceGroup: string;
    /** Location of the fleet. */
    location: string;
    /** Whether the fleet has a hub cluster. */
    hasHub: boolean;
    /** FQDN of the hub API server. */
    hubFqdn: string | undefined;
    /** Kubernetes version of the hub cluster. */
    hubKubernetesVersion: string | undefined;
    /** Principal ID of the system-assigned identity. */
    principalId: string | undefined;
    /** User tags (Alchemy ownership tags stripped). */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * An Azure Kubernetes Fleet Manager fleet that groups AKS clusters for
 * coordinated upgrades and (with a hub) multi-cluster resource placement.
 *
 * A hubless fleet is free; a hub runs a small managed AKS cluster.
 *
 * @see https://learn.microsoft.com/azure/kubernetes-fleet/overview
 *
 * ### Creating a Fleet
 * **Example:** Hubless fleet for update orchestration
 * ```typescript
 * const fleet = yield* Azure.ContainerService.Fleet("fleet", {
 *   resourceGroup: group.resourceGroupName,
 * });
 * ```
 *
 * **Example:** Fleet with a hub cluster
 * ```typescript
 * const fleet = yield* Azure.ContainerService.Fleet("fleet", {
 *   resourceGroup: group.resourceGroupName,
 *   hubProfile: { agentVmSize: "Standard_D2s_v7" },
 *   systemAssignedIdentity: true,
 * });
 * ```
 *
 * @resource
 */
export const Fleet = Resource<Fleet>("Azure.ContainerService.Fleet");

type ObservedFleet = cs.GetFleetResponse;

const createFleetName = (id: string) => createChildName(id, 63);

const toAttrs = (
  resourceGroup: string,
  name: string,
  fleet: ObservedFleet,
): Fleet["Attributes"] => ({
  fleetName: name,
  fleetId: fleet.id ?? "",
  resourceGroup,
  location: fleet.location,
  hasHub: fleet.properties?.hubProfile !== undefined,
  hubFqdn: fleet.properties?.hubProfile?.fqdn,
  hubKubernetesVersion: fleet.properties?.hubProfile?.kubernetesVersion,
  principalId: fleet.identity?.principalId,
  tags: userTags(fleet.tags),
});

const desiredIdentity = (
  news: FleetProps,
): cs.FleetsCreateOrUpdateRequestIdentity => {
  const users = news.userAssignedIdentityIds ?? [];
  const system = news.systemAssignedIdentity ?? false;
  const type =
    system && users.length > 0
      ? "SystemAssigned, UserAssigned"
      : system
        ? "SystemAssigned"
        : users.length > 0
          ? "UserAssigned"
          : "None";
  return users.length > 0
    ? {
        type,
        userAssignedIdentities: Object.fromEntries(
          users.map((userId) => [userId, {}]),
        ),
      }
    : { type };
};

const identityMatches = (
  desired: cs.FleetsCreateOrUpdateRequestIdentity,
  observed: ObservedFleet["identity"],
) => {
  const observedType = observed?.type ?? "None";
  if (observedType.replace(/\s/g, "") !== desired.type.replace(/\s/g, "")) {
    return false;
  }
  const want = Object.keys(desired.userAssignedIdentities ?? {});
  const have = Object.keys(observed?.userAssignedIdentities ?? {});
  return (
    want.length === have.length &&
    want.every((key) => have.some((other) => sameName(key, other)))
  );
};

const hubBody = (
  hub: FleetHubProfile,
  name: string,
): cs.FleetHubProfileInput => ({
  dnsPrefix: hub.dnsPrefix ?? name.slice(0, 54),
  agentProfile:
    hub.agentVmSize !== undefined || hub.agentSubnetId !== undefined
      ? { vmSize: hub.agentVmSize, subnetId: hub.agentSubnetId }
      : undefined,
  apiServerAccessProfile:
    hub.enablePrivateCluster !== undefined ||
    hub.enableVnetIntegration !== undefined ||
    hub.apiServerSubnetId !== undefined
      ? {
          enablePrivateCluster: hub.enablePrivateCluster,
          enableVnetIntegration: hub.enableVnetIntegration,
          subnetId: hub.apiServerSubnetId,
        }
      : undefined,
});

const stateOf = (fleet: ObservedFleet) => fleet.properties?.provisioningState;

const isPending = (state: string | undefined) =>
  state !== undefined &&
  state !== "Succeeded" &&
  state !== "Failed" &&
  state !== "Canceled";

const lower = (value: string | undefined) => value?.toLowerCase();

export const FleetProvider = () =>
  Provider.succeed(Fleet, {
    stables: ["fleetName", "fleetId", "resourceGroup", "location"],

    list: Effect.fn(function* () {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const page = yield* cs
        .ListFleetBySubscription({ subscriptionId })
        .pipe(
          Effect.flatMap((page) =>
            requireSinglePage("ListFleetBySubscription", page),
          ),
        );
      return (page.value ?? []).flatMap((fleet) => {
        const group = resourceGroupOf(fleet.id);
        return hasAnyAlchemyTag(fleet.tags) &&
          group !== undefined &&
          fleet.name !== undefined
          ? [toAttrs(group, fleet.name, fleet)]
          : [];
      });
    }),

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        !sameName(news.resourceGroup, output.resourceGroup) ||
        (news.name !== undefined && news.name !== output.fleetName) ||
        (news.location !== undefined &&
          lower(news.location) !== lower(output.location)) ||
        (news.hubProfile !== undefined) !== output.hasHub ||
        (olds !== undefined &&
          JSON.stringify(olds.hubProfile ?? null) !==
            JSON.stringify(news.hubProfile ?? null))
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
        output?.fleetName ?? olds?.name ?? (yield* createFleetName(id));
      const observed = yield* getFleet(subscriptionId, resourceGroup, name);
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, name, observed);
      return (yield* isOwned(id, observed.tags)) ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* AzureEnvironment.current;
      const { subscriptionId } = env;
      yield* ensureRegistered(subscriptionId, "Microsoft.ContainerService");
      const resourceGroup = news.resourceGroup;
      const name =
        news.name ?? output?.fleetName ?? (yield* createFleetName(id));
      const location = news.location ?? output?.location ?? env.location;
      const tags = yield* desiredTags(id, news.tags);
      const identity = desiredIdentity(news);
      const where = {
        subscriptionId,
        resourceGroupName: resourceGroup,
        fleetName: name,
      };
      const get = getFleet(subscriptionId, resourceGroup, name);
      // A hubless fleet settles in seconds; a hub takes 10-15 minutes.
      const waitReady = waitForProvisioned(`fleet ${name}`, get, stateOf, {
        interval: "15 seconds",
        times: 100,
      });

      // Observe.
      let observed = yield* get;
      if (observed !== undefined && isPending(stateOf(observed))) {
        observed = yield* waitReady;
      }

      // Ensure.
      if (observed === undefined) {
        yield* cs
          .FleetsCreateOrUpdate({
            ...where,
            location,
            tags,
            identity,
            properties: news.hubProfile
              ? { hubProfile: hubBody(news.hubProfile, name) }
              : {},
          })
          .pipe(Effect.retry(whileFleetBusy));
        observed = yield* waitReady;
      }

      // Sync tags and identity (the only mutable aspects) via PATCH.
      const identityDrift = !identityMatches(identity, observed.identity);
      const tagDrift = tagsDiffer(observed.tags, tags);
      if (identityDrift || tagDrift) {
        yield* cs
          .UpdateFleet({
            ...where,
            tags: tagDrift ? tags : undefined,
            identity: identityDrift ? identity : undefined,
          })
          .pipe(Effect.retry(whileFleetBusy));
        observed = yield* waitReady;
      }

      return toAttrs(resourceGroup, name, observed);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        cs
          .DeleteFleet({
            subscriptionId,
            resourceGroupName: output.resourceGroup,
            fleetName: output.fleetName,
          })
          .pipe(Effect.retry(whileFleetBusy)),
      );
      yield* waitUntilGone(
        `fleet ${output.fleetName}`,
        getFleet(subscriptionId, output.resourceGroup, output.fleetName),
        { interval: "15 seconds", times: 100 },
      );
    }),

    nuke: { dependsOn: ["Azure.Resources.ResourceGroup"] },
  });
