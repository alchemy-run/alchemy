import * as aci from "@distilled.cloud/azure/containerinstance";
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
  createContainerInstanceName,
  fingerprint,
  identityMatches,
  lower,
  matchesDesired,
  sameLocation,
  toIdentity,
  type ContainerInstanceIdentity,
} from "./common.ts";

/** A container group profile an NGroup creates its container groups from. */
export interface NGroupContainerGroupProfile {
  /** ARM ID of the profile (`profile.containerGroupProfileId`). */
  id: string;
  /**
   * Profile revision to use (`profile.revision`).
   * @default the profile's latest revision
   */
  revision?: number;
  /** Load balancer / application gateway backend pools to register groups in. */
  networkProfile?: aci.NetworkProfile;
  /** Azure Files shares to create per container group. */
  storageProfile?: aci.StorageProfile;
  /** Per-NGroup overrides of the profile's container group properties (subnets, volumes, mounts). */
  containerGroupProperties?: aci.NGroupContainerGroupProperties;
}

export interface NGroupProps {
  /** Resource group the NGroup is created in. Changing it replaces the NGroup. */
  resourceGroup: string;
  /**
   * NGroup name: 1-63 lowercase letters, digits, and hyphens. If omitted, a
   * unique name is generated from the app, stage, and logical ID. Changing
   * it replaces the NGroup.
   */
  name?: string;
  /**
   * Azure location. Changing it replaces the NGroup.
   * @default the `Azure.Location` layer, else the profile location, else `eastus`
   */
  location?: string;
  /** Availability zones to spread container groups across. Changing them replaces the NGroup. */
  zones?: string[];
  /** Profiles the NGroup creates its container groups from. */
  containerGroupProfiles: NGroupContainerGroupProfile[];
  /**
   * Number of container groups to run. Each one is billed like a
   * standalone container group.
   * @default 0
   */
  desiredCount?: number;
  /**
   * Recreate container groups that are deleted out of band, keeping
   * `desiredCount` running.
   * @default Azure's default (`false`)
   */
  maintainDesiredCount?: boolean;
  /** Prefix of the generated container group names. */
  containerGroupNamePrefix?: string;
  /** Number of fault domains to spread container groups across. */
  faultDomainCount?: number;
  /** How profile changes roll out to existing container groups. */
  updateProfile?: aci.UpdateProfile;
  /** Managed identity of the NGroup. */
  identity?: ContainerInstanceIdentity;
  /**
   * User tags. Alchemy ownership tags (`alchemy::stack`, `alchemy::stage`,
   * `alchemy::id`) are merged in automatically.
   */
  tags?: Record<string, string>;
}

export interface NGroup extends Resource<
  "Azure.ContainerInstance.NGroup",
  NGroupProps,
  {
    /** Name of the NGroup. */
    nGroupName: string;
    /** ARM resource ID of the NGroup. */
    nGroupId: string;
    /** Resource group that holds the NGroup. */
    resourceGroup: string;
    /** Location of the NGroup. */
    location: string;
    /** Desired number of container groups. */
    desiredCount: number | undefined;
    /** Principal ID of the system-assigned identity, if enabled. */
    principalId: string | undefined;
    /** User tags (Alchemy ownership tags stripped). */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * An Azure Container Instances NGroup (`Microsoft.ContainerInstance/ngroups`)
 * — a fleet of identical container groups created from a
 * `ContainerGroupProfile` and scaled by `desiredCount`.
 *
 * Deploys block until the NGroup is provisioned. Deleting the NGroup
 * deletes every container group it created.
 *
 * @see https://learn.microsoft.com/azure/container-instances/container-instance-ngroups/container-instances-about-ngroups
 *
 * ### Creating an NGroup
 * **Example:** Two replicas of a profile
 * ```typescript
 * const group = yield* Azure.Resources.ResourceGroup("app");
 * const profile = yield* Azure.ContainerInstance.ContainerGroupProfile("web", {
 *   resourceGroup: group.resourceGroupName,
 *   containers: [
 *     {
 *       name: "web",
 *       image: "mcr.microsoft.com/azuredocs/aci-helloworld",
 *       cpu: 0.5,
 *       memoryInGB: 0.5,
 *     },
 *   ],
 * });
 * const fleet = yield* Azure.ContainerInstance.NGroup("fleet", {
 *   resourceGroup: group.resourceGroupName,
 *   desiredCount: 2,
 *   maintainDesiredCount: true,
 *   containerGroupProfiles: [
 *     { id: profile.containerGroupProfileId, revision: profile.revision },
 *   ],
 * });
 * ```
 *
 * ### Rolling Updates
 * **Example:** Roll profile revisions out in batches
 * ```typescript
 * const fleet = yield* Azure.ContainerInstance.NGroup("fleet", {
 *   resourceGroup: group.resourceGroupName,
 *   desiredCount: 4,
 *   updateProfile: {
 *     updateMode: "Rolling",
 *     rollingUpdateProfile: { maxBatchPercent: 25, inPlaceUpdate: true },
 *   },
 *   containerGroupProfiles: [
 *     { id: profile.containerGroupProfileId, revision: profile.revision },
 *   ],
 * });
 * ```
 *
 * @resource
 */
export const NGroup = Resource<NGroup>("Azure.ContainerInstance.NGroup");

const getNGroup = (
  subscriptionId: string,
  resourceGroupName: string,
  ngroupsName: string,
) =>
  orUndefinedIfNotFound(
    aci.GetNGroup({ subscriptionId, resourceGroupName, ngroupsName }),
  );

const toAttrs = (
  resourceGroup: string,
  name: string,
  observed: Pick<
    aci.GetNGroupResponse,
    "id" | "location" | "properties" | "identity" | "tags"
  >,
): NGroup["Attributes"] => ({
  nGroupName: name,
  nGroupId: observed.id ?? "",
  resourceGroup,
  location: observed.location ?? "",
  desiredCount: observed.properties?.elasticProfile?.desiredCount,
  principalId: observed.identity?.principalId,
  tags: userTags(observed.tags),
});

const toProperties = (props: NGroupProps): aci.NGroupProperties => ({
  elasticProfile: {
    desiredCount: props.desiredCount ?? 0,
    maintainDesiredCount: props.maintainDesiredCount,
    containerGroupNamingPolicy:
      props.containerGroupNamePrefix === undefined
        ? undefined
        : {
            guidNamingPolicy: { prefix: props.containerGroupNamePrefix },
          },
  },
  placementProfile:
    props.faultDomainCount === undefined
      ? undefined
      : { faultDomainCount: props.faultDomainCount },
  containerGroupProfiles: props.containerGroupProfiles.map((p) => ({
    resource: { id: p.id },
    revision: p.revision,
    networkProfile: p.networkProfile,
    storageProfile: p.storageProfile,
    containerGroupProperties: p.containerGroupProperties,
  })),
  updateProfile: props.updateProfile,
});

const sorted = (values: ReadonlyArray<string> | undefined) =>
  (values ?? [])
    .map((v) => v.toLowerCase())
    .sort()
    .join("|");

export const NGroupProvider = () =>
  Provider.succeed(NGroup, {
    stables: ["nGroupName", "nGroupId", "resourceGroup", "location"],

    list: Effect.fn(function* () {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const page = yield* aci
        .ListNGroups({ subscriptionId })
        .pipe(Effect.flatMap((page) => requireSinglePage("ListNGroups", page)));
      return (page.value ?? []).flatMap((observed) => {
        const group = resourceGroupOf(observed.id);
        return hasAnyAlchemyTag(observed.tags) &&
          group !== undefined &&
          observed.name !== undefined
          ? [toAttrs(group, observed.name, observed)]
          : [];
      });
    }),

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        lower(news.resourceGroup) !== lower(output.resourceGroup) ||
        (news.name !== undefined && news.name !== output.nGroupName) ||
        (news.location !== undefined &&
          !sameLocation(news.location, output.location)) ||
        sorted(news.zones) !== sorted(olds.zones)
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
        output?.nGroupName ??
        olds?.name ??
        (yield* createContainerInstanceName(id));
      const observed = yield* getNGroup(subscriptionId, resourceGroup, name);
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, name, observed);
      return (yield* isOwned(id, observed.tags)) ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, olds, output }) {
      const env = yield* AzureEnvironment.current;
      const { subscriptionId } = env;
      yield* ensureRegistered(subscriptionId, "Microsoft.ContainerInstance");
      const resourceGroup = news.resourceGroup;
      const name =
        news.name ??
        output?.nGroupName ??
        (yield* createContainerInstanceName(id));
      const location = news.location ?? output?.location ?? env.location;
      const tags = yield* desiredTags(id, news.tags);
      const properties = toProperties(news);
      const where = {
        subscriptionId,
        resourceGroupName: resourceGroup,
        ngroupsName: name,
      };
      const get = getNGroup(subscriptionId, resourceGroup, name);
      const ready = waitForProvisioned(
        `NGroup ${name}`,
        get,
        (ngroup) => ngroup.properties?.provisioningState,
        { interval: "10 seconds", times: 60 },
      );
      const put = aci.NGroupsCreateOrUpdate({
        ...where,
        location,
        zones: news.zones,
        tags,
        identity: toIdentity(news.identity),
        properties,
      });

      // Observe.
      let observed = yield* get;

      // Ensure.
      if (observed === undefined) {
        yield* put;
        observed = yield* ready;
      } else {
        // Wait out an in-flight operation before comparing.
        observed = yield* ready;
        // Sync the spec against observed state; removed properties are
        // only visible against the previous props.
        const specInSync =
          matchesDesired(properties, observed.properties) &&
          identityMatches(news.identity, observed.identity) &&
          (olds === undefined ||
            fingerprint(properties) === fingerprint(toProperties(olds)));
        if (!specInSync) {
          yield* put;
          observed = yield* ready;
        } else if (tagsDiffer(observed.tags, tags)) {
          yield* aci.UpdateNGroup({ ...where, tags });
          observed = yield* ready;
        }
      }

      return toAttrs(resourceGroup, name, observed);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        aci.DeleteNGroup({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          ngroupsName: output.nGroupName,
        }),
      );
      // Deleting an NGroup also deletes every container group it created.
      yield* waitUntilGone(
        `NGroup ${output.nGroupName}`,
        getNGroup(subscriptionId, output.resourceGroup, output.nGroupName),
        { interval: "10 seconds", times: 60 },
      );
    }),

    nuke: {
      dependsOn: [
        "Azure.ContainerInstance.ContainerGroupProfile",
        "Azure.Resources.ResourceGroup",
      ],
    },
  });
