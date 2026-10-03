import * as azurefleet from "@distilled.cloud/azure/azurefleet";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
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

export type FleetComputeProfile = azurefleet.ComputeProfileInput;
export type FleetVmSizeProfile = azurefleet.VmSizeProfile;
export type FleetVmAttributes = azurefleet.VMAttributes;
export type FleetSpotPriorityProfile = azurefleet.SpotPriorityProfile;
export type FleetRegularPriorityProfile = azurefleet.RegularPriorityProfile;
export type FleetAdditionalLocationsProfile =
  azurefleet.AdditionalLocationsProfileInput;
export type FleetPlan = azurefleet.FleetsCreateOrUpdateRequestPlan;

export interface FleetIdentity {
  /**
   * Enable the system-assigned managed identity.
   * @default false
   */
  systemAssigned?: boolean;
  /** ARM IDs of user-assigned managed identities to attach. */
  userAssignedIdentityIds?: string[];
}

export interface FleetProps {
  /**
   * Resource group the fleet is created in. Changing it replaces the fleet.
   */
  resourceGroup: string;
  /**
   * Name of the fleet: 1-64 letters, digits, `.`, `_`, and `-`. If omitted,
   * a unique name is generated from the app, stage, and logical ID.
   * Changing it replaces the fleet.
   */
  name?: string;
  /**
   * Azure location of the fleet. Changing it replaces the fleet.
   * @default the `Azure.Location` layer, else the profile location, else `eastus`
   */
  location?: string;
  /**
   * Availability zones the fleet's VMs are spread over. Changing them
   * replaces the fleet.
   */
  zones?: string[];
  /**
   * Marketplace plan of the VM image (marketplace images only). Changing it
   * replaces the fleet.
   */
  plan?: FleetPlan;
  /**
   * VM sizes the fleet may allocate, optionally ranked (lower `rank` =
   * higher priority with the `Prioritized` allocation strategy). Updated in
   * place.
   */
  vmSizesProfile: FleetVmSizeProfile[];
  /**
   * Attribute-based VM selection (vCPU / memory ranges, architectures,
   * ...), an alternative to listing sizes. Updated in place.
   */
  vmAttributes?: FleetVmAttributes;
  /**
   * Regular (pay-as-you-go) capacity. `capacity` scales in place; changing
   * `minCapacity` or `allocationStrategy` replaces the fleet.
   */
  regularPriorityProfile?: FleetRegularPriorityProfile;
  /**
   * Spot capacity. `capacity` scales in place; changing any other field
   * replaces the fleet. Spot VMs are unavailable on free-trial
   * subscriptions.
   */
  spotPriorityProfile?: FleetSpotPriorityProfile;
  /**
   * The VM template of the fleet's underlying scale sets (OS, storage,
   * network, security profiles), plus the Compute API version and fault
   * domain count. The network profile needs `networkApiVersion:
   * "2020-11-01"` (flexible orchestration). Changing it replaces the fleet.
   */
  computeProfile: FleetComputeProfile;
  /**
   * Additional regions the fleet may deploy VMs to. Changing it replaces
   * the fleet.
   */
  additionalLocationsProfile?: FleetAdditionalLocationsProfile;
  /**
   * Managed identities of the fleet. Updated in place.
   */
  identity?: FleetIdentity;
  /**
   * User tags. Alchemy ownership tags (`alchemy::stack`, `alchemy::stage`,
   * `alchemy::id`) are merged in automatically.
   */
  tags?: Record<string, string>;
}

export interface Fleet extends Resource<
  "Azure.AzureFleet.Fleet",
  FleetProps,
  {
    /** Name of the fleet. */
    fleetName: string;
    /** ARM resource ID of the fleet. */
    fleetId: string;
    /** Resource group that holds the fleet. */
    resourceGroup: string;
    /** Location of the fleet. */
    location: string;
    /** Zones of the fleet. */
    zones: string[];
    /** Provisioning state of the last operation. */
    provisioningState: string | undefined;
    /** Immutable unique ID Azure assigned to the fleet. */
    uniqueId: string | undefined;
    /** Creation time (ISO 8601). */
    timeCreated: string | undefined;
    /** Principal ID of the system-assigned identity, if enabled. */
    principalId: string | undefined;
    /** Target regular-priority capacity (number of VMs). */
    regularCapacity: number | undefined;
    /** Target Spot capacity (number of VMs). */
    spotCapacity: number | undefined;
    /** VM sizes the fleet may allocate. */
    vmSizes: string[];
    /** User tags (Alchemy ownership tags stripped). */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * An Azure Compute Fleet — one resource that provisions a mix of VM sizes
 * and Spot / regular capacity across underlying flexible scale sets. The
 * fleet's VMs, disks, and NICs are deleted with it.
 *
 * Target capacity, the VM size list, attribute-based selection, identity,
 * and tags update in place; the VM template (`computeProfile`) and the
 * minimum capacities are fixed at creation.
 *
 * @see https://learn.microsoft.com/azure/azure-compute-fleet/overview
 *
 * ### Creating a Fleet
 * **Example:** One regular-priority Linux VM from two candidate sizes
 * ```typescript
 * const fleet = yield* Azure.AzureFleet.Fleet("workers", {
 *   resourceGroup: group.resourceGroupName,
 *   vmSizesProfile: [{ name: "Standard_D2as_v5" }, { name: "Standard_D2s_v5" }],
 *   regularPriorityProfile: {
 *     capacity: 1,
 *     minCapacity: 1,
 *     allocationStrategy: "LowestPrice",
 *   },
 *   computeProfile: {
 *     baseVirtualMachineProfile: {
 *       storageProfile: {
 *         imageReference: {
 *           publisher: "Canonical",
 *           offer: "ubuntu-24_04-lts",
 *           sku: "server",
 *           version: "latest",
 *         },
 *         osDisk: { createOption: "FromImage", managedDisk: { storageAccountType: "Standard_LRS" } },
 *       },
 *       osProfile: {
 *         computerNamePrefix: "worker",
 *         adminUsername: "azureuser",
 *         linuxConfiguration: {
 *           disablePasswordAuthentication: true,
 *           ssh: { publicKeys: [{ path: "/home/azureuser/.ssh/authorized_keys", keyData: publicKey }] },
 *         },
 *       },
 *       networkProfile: {
 *         networkApiVersion: "2020-11-01",
 *         networkInterfaceConfigurations: [{
 *           name: "nic",
 *           properties: {
 *             primary: true,
 *             ipConfigurations: [{ name: "ipconfig", properties: { primary: true, subnet: { id: subnet.subnetId } } }],
 *           },
 *         }],
 *       },
 *     },
 *   },
 * });
 * ```
 *
 * ### Mixing Spot and Regular Capacity
 * **Example:** Spot capacity with a regular-priority floor
 * ```typescript
 * const fleet = yield* Azure.AzureFleet.Fleet("batch", {
 *   resourceGroup: group.resourceGroupName,
 *   vmSizesProfile: [{ name: "Standard_D4as_v5" }, { name: "Standard_D4s_v5" }],
 *   spotPriorityProfile: {
 *     capacity: 8,
 *     minCapacity: 0,
 *     evictionPolicy: "Delete",
 *     allocationStrategy: "PriceCapacityOptimized",
 *     maintain: true,
 *   },
 *   regularPriorityProfile: { capacity: 2, minCapacity: 2 },
 *   computeProfile,
 * });
 * ```
 *
 * @resource
 */
export const Fleet = Resource<Fleet>("Azure.AzureFleet.Fleet");

type Observed = azurefleet.GetFleetResponse;

const lower = (value: string | undefined) => value?.toLowerCase();

/** Canonical JSON (sorted keys, `undefined` dropped) for structural diffs. */
const canonical = (value: unknown): string =>
  JSON.stringify(value ?? null, (_key, v) =>
    v !== null && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(
          Object.keys(v)
            .sort()
            .map((k) => [k, (v as Record<string, unknown>)[k]]),
        )
      : v,
  );

const sameSet = (a: string[] | undefined, b: string[] | undefined) =>
  canonical([...(a ?? [])].sort()) === canonical([...(b ?? [])].sort());

const createFleetName = (id: string) =>
  createPhysicalName({ id, maxLength: 64 });

const getFleet = (
  subscriptionId: string,
  resourceGroupName: string,
  fleetName: string,
) =>
  orUndefinedIfNotFound(
    azurefleet.GetFleet({ subscriptionId, resourceGroupName, fleetName }),
  );

const toAttrs = (
  resourceGroup: string,
  name: string,
  fleet: Observed,
): Fleet["Attributes"] => ({
  fleetName: name,
  fleetId: fleet.id ?? "",
  resourceGroup,
  location: fleet.location,
  zones: [...(fleet.zones ?? [])],
  provisioningState: fleet.properties?.provisioningState,
  uniqueId: fleet.properties?.uniqueId,
  timeCreated: fleet.properties?.timeCreated,
  principalId: fleet.identity?.principalId,
  regularCapacity: fleet.properties?.regularPriorityProfile?.capacity,
  spotCapacity: fleet.properties?.spotPriorityProfile?.capacity,
  vmSizes: (fleet.properties?.vmSizesProfile ?? []).map((size) => size.name),
  tags: userTags(fleet.tags),
});

// Assignable to both the create (`FleetsCreateOrUpdateRequestIdentity`) and
// the PATCH (`ManagedServiceIdentityUpdateInput`) identity shapes.
interface IdentityInput {
  type: azurefleet.ManagedServiceIdentityType;
  userAssignedIdentities?: Record<string, azurefleet.UserAssignedIdentityInput>;
}

const identityInput = (
  identity: FleetIdentity | undefined,
): IdentityInput | undefined => {
  if (identity === undefined) return undefined;
  const system = identity.systemAssigned ?? false;
  const users = identity.userAssignedIdentityIds ?? [];
  return {
    type:
      system && users.length > 0
        ? "SystemAssigned,UserAssigned"
        : system
          ? "SystemAssigned"
          : users.length > 0
            ? "UserAssigned"
            : "None",
    userAssignedIdentities:
      users.length > 0
        ? Object.fromEntries(users.map((userId) => [userId, {}]))
        : undefined,
  };
};

const identityKey = (
  type: string | undefined,
  userIds: ReadonlyArray<string>,
) =>
  canonical({
    system: (type ?? "None").includes("SystemAssigned"),
    users: userIds.map((id) => id.toLowerCase()).sort(),
  });

/** Priority-profile fields that are fixed at creation (all but `capacity`). */
const fixedPriority = (
  profile: FleetRegularPriorityProfile | FleetSpotPriorityProfile | undefined,
) => {
  if (profile === undefined) return canonical(undefined);
  const { capacity: _capacity, ...rest } = profile;
  return canonical(rest);
};

const sizesKey = (sizes: ReadonlyArray<FleetVmSizeProfile> | undefined) =>
  canonical(
    (sizes ?? [])
      .map((size) => ({ name: size.name.toLowerCase(), rank: size.rank }))
      .sort((a, b) => a.name.localeCompare(b.name)),
  );

const propertiesInput = (
  news: FleetProps,
): azurefleet.FleetPropertiesInput => ({
  vmSizesProfile: news.vmSizesProfile,
  vmAttributes: news.vmAttributes,
  regularPriorityProfile: news.regularPriorityProfile,
  spotPriorityProfile: news.spotPriorityProfile,
  computeProfile: news.computeProfile,
  additionalLocationsProfile: news.additionalLocationsProfile,
});

/**
 * Azure Fleet rejects a write while the previous operation on the fleet
 * (or its scale sets) is still running.
 */
const whileFleetBusy = {
  while: (e: { readonly _tag: string }) => e._tag === "ResourceConflict",
  schedule: Schedule.spaced("10 seconds"),
  times: 30,
} as const;

const provisionedBudget = { interval: "10 seconds", times: 90 } as const;

export const FleetProvider = () =>
  Provider.succeed(Fleet, {
    stables: [
      "fleetName",
      "fleetId",
      "resourceGroup",
      "location",
      "uniqueId",
      "timeCreated",
    ],

    list: Effect.fn(function* () {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const page = yield* azurefleet
        .ListFleetBySubscription({ subscriptionId })
        .pipe(
          Effect.flatMap((page) =>
            requireSinglePage("ListFleetBySubscription", page),
          ),
        );
      return (page.value ?? []).flatMap((fleet) => {
        const resourceGroup = resourceGroupOf(fleet.id);
        return hasAnyAlchemyTag(fleet.tags) &&
          resourceGroup !== undefined &&
          fleet.name !== undefined
          ? [toAttrs(resourceGroup, fleet.name, fleet)]
          : [];
      });
    }),

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        lower(news.resourceGroup) !== lower(output.resourceGroup) ||
        (news.name !== undefined &&
          lower(news.name) !== lower(output.fleetName)) ||
        (news.location !== undefined &&
          lower(news.location) !== lower(output.location)) ||
        !sameSet(news.zones, output.zones)
      ) {
        return { action: "replace" } as const;
      }
      if (
        olds !== undefined &&
        (canonical(news.computeProfile) !== canonical(olds.computeProfile) ||
          canonical(news.plan) !== canonical(olds.plan) ||
          canonical(news.additionalLocationsProfile) !==
            canonical(olds.additionalLocationsProfile) ||
          fixedPriority(news.regularPriorityProfile) !==
            fixedPriority(olds.regularPriorityProfile) ||
          fixedPriority(news.spotPriorityProfile) !==
            fixedPriority(olds.spotPriorityProfile) ||
          (news.regularPriorityProfile === undefined) !==
            (olds.regularPriorityProfile === undefined) ||
          (news.spotPriorityProfile === undefined) !==
            (olds.spotPriorityProfile === undefined))
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
      yield* ensureRegistered(subscriptionId, "Microsoft.AzureFleet");
      const resourceGroup = news.resourceGroup;
      const name =
        news.name ?? output?.fleetName ?? (yield* createFleetName(id));
      const location = news.location ?? output?.location ?? env.location;
      const tags = yield* desiredTags(id, news.tags);
      const desiredIdentity = identityInput(news.identity);
      const where = {
        subscriptionId,
        resourceGroupName: resourceGroup,
        fleetName: name,
      };
      const label = `compute fleet ${name}`;
      const get = getFleet(subscriptionId, resourceGroup, name);
      const wait = waitForProvisioned(
        label,
        get,
        (fleet) => fleet.properties?.provisioningState,
        provisionedBudget,
      );

      // Observe.
      let observed = yield* get;

      // Ensure. Creation is a long-running operation.
      if (observed === undefined) {
        yield* azurefleet.FleetsCreateOrUpdate({
          ...where,
          location,
          zones: news.zones,
          plan: news.plan,
          identity: desiredIdentity,
          tags,
          properties: propertiesInput(news),
        });
      }
      observed = yield* wait;

      // Sync mutable aspects against observed state.
      const props = observed.properties;
      const propertiesChanged =
        (news.regularPriorityProfile?.capacity !== undefined &&
          props?.regularPriorityProfile?.capacity !==
            news.regularPriorityProfile.capacity) ||
        (news.spotPriorityProfile?.capacity !== undefined &&
          props?.spotPriorityProfile?.capacity !==
            news.spotPriorityProfile.capacity) ||
        sizesKey(props?.vmSizesProfile) !== sizesKey(news.vmSizesProfile) ||
        (news.vmAttributes !== undefined &&
          canonical(props?.vmAttributes) !== canonical(news.vmAttributes));
      const identityChanged =
        desiredIdentity !== undefined &&
        identityKey(
          observed.identity?.type,
          Object.keys(observed.identity?.userAssignedIdentities ?? {}),
        ) !==
          identityKey(
            desiredIdentity.type,
            news.identity?.userAssignedIdentityIds ?? [],
          );
      const tagsChanged = tagsDiffer(observed.tags, tags);
      if (propertiesChanged || identityChanged || tagsChanged) {
        yield* azurefleet
          .UpdateFleet({
            ...where,
            tags: tagsChanged ? tags : undefined,
            identity: identityChanged ? desiredIdentity : undefined,
            properties: propertiesChanged ? propertiesInput(news) : undefined,
          })
          .pipe(Effect.retry(whileFleetBusy));
        observed = yield* wait;
      }

      return toAttrs(resourceGroup, name, observed);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        azurefleet.DeleteFleet({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          fleetName: output.fleetName,
        }),
      ).pipe(Effect.retry(whileFleetBusy));
      yield* waitUntilGone(
        `compute fleet ${output.fleetName}`,
        getFleet(subscriptionId, output.resourceGroup, output.fleetName),
        { interval: "10 seconds", times: 90 },
      );
    }),

    nuke: { dependsOn: ["Azure.Resources.ResourceGroup"] },
  });
