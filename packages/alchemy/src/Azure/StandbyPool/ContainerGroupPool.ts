import * as standbypool from "@distilled.cloud/azure/standbypool";
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
  createStandbyPoolName,
  lower,
  sameLocation,
  sortedKey,
} from "./common.ts";

export interface ContainerGroupPoolProps {
  /** Resource group the pool is created in. Changing it replaces the pool. */
  resourceGroup: string;
  /**
   * Pool name: 3-24 letters, digits, and hyphens. If omitted, a unique name
   * is generated from the app, stage, and logical ID. Changing it replaces
   * the pool.
   */
  name?: string;
  /**
   * Azure location. Must match the container group profile's location.
   * Changing it replaces the pool.
   * @default the `Azure.Location` layer, else `eastus`
   */
  location?: string;
  /** Availability zones of the pooled container groups. Changing them replaces the pool. */
  zones?: string[];
  /**
   * ARM ID of the `Microsoft.ContainerInstance/containerGroupProfiles`
   * template the pooled container groups are created from, e.g.
   * `profile.containerGroupProfileId`. Changing it replaces the pool.
   */
  containerGroupProfileId: string;
  /**
   * Profile revision to pool. Pass `profile.revision` to roll the pool when
   * the profile changes.
   * @default the profile's latest revision
   */
  containerGroupProfileRevision?: number;
  /** ARM IDs of the subnets the pooled container groups join. */
  subnetIds?: string[];
  /** Maximum number of ready container groups kept in the pool. */
  maxReadyCapacity: number;
  /**
   * Refill policy of the pool.
   * @default "always"
   */
  refillPolicy?: "always";
  /**
   * Let Azure size the pool dynamically from usage forecasts (up to
   * `maxReadyCapacity`).
   * @default false
   */
  dynamicSizing?: boolean;
  /**
   * User tags. Alchemy ownership tags (`alchemy::stack`, `alchemy::stage`,
   * `alchemy::id`) are merged in automatically.
   */
  tags?: Record<string, string>;
}

export interface ContainerGroupPool extends Resource<
  "Azure.StandbyPool.ContainerGroupPool",
  ContainerGroupPoolProps,
  {
    /** Name of the pool. */
    standbyContainerGroupPoolName: string;
    /** ARM resource ID of the pool. */
    standbyContainerGroupPoolId: string;
    /** Resource group that holds the pool. */
    resourceGroup: string;
    /** Location of the pool. */
    location: string;
    /** Last provisioning state reported by Azure. */
    provisioningState: string | undefined;
    /** Maximum number of ready container groups. */
    maxReadyCapacity: number | undefined;
    /** Profile the pooled container groups are created from. */
    containerGroupProfileId: string | undefined;
    /** Profile revision the pool uses. */
    containerGroupProfileRevision: number | undefined;
    /** User tags (Alchemy ownership tags stripped). */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * An Azure standby container group pool
 * (`Microsoft.StandbyPool/standbyContainerGroupPools`) — keeps
 * pre-provisioned Azure Container Instances container groups, created from
 * a container group profile, ready to cut scale-out latency.
 *
 * The pool itself is free; the pooled container groups bill as regular
 * container groups. The "Standby Pool Resource Provider" service principal
 * needs the `Azure Container Instances Contributor Role` (plus `Network
 * Contributor` for subnets) on the resource group to fill the pool.
 *
 * @see https://learn.microsoft.com/azure/container-instances/container-instances-standby-pools
 *
 * ### Creating a Pool
 * **Example:** Keep one container group warm
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
 * const pool = yield* Azure.StandbyPool.ContainerGroupPool("web-pool", {
 *   resourceGroup: group.resourceGroupName,
 *   containerGroupProfileId: profile.containerGroupProfileId,
 *   containerGroupProfileRevision: profile.revision,
 *   maxReadyCapacity: 1,
 * });
 * ```
 *
 * ### Sizing
 * **Example:** Dynamic sizing up to five container groups
 * ```typescript
 * const pool = yield* Azure.StandbyPool.ContainerGroupPool("web-pool", {
 *   resourceGroup: group.resourceGroupName,
 *   containerGroupProfileId: profile.containerGroupProfileId,
 *   maxReadyCapacity: 5,
 *   dynamicSizing: true,
 * });
 * ```
 *
 * @resource
 */
export const ContainerGroupPool = Resource<ContainerGroupPool>(
  "Azure.StandbyPool.ContainerGroupPool",
);

const getPool = (
  subscriptionId: string,
  resourceGroupName: string,
  standbyContainerGroupPoolName: string,
) =>
  orUndefinedIfNotFound(
    standbypool.GetStandbyContainerGroupPool({
      subscriptionId,
      resourceGroupName,
      standbyContainerGroupPoolName,
    }),
  );

const toAttrs = (
  resourceGroup: string,
  name: string,
  observed: Pick<
    standbypool.GetStandbyContainerGroupPoolResponse,
    "id" | "location" | "properties" | "tags"
  >,
): ContainerGroupPool["Attributes"] => ({
  standbyContainerGroupPoolName: name,
  standbyContainerGroupPoolId: observed.id ?? "",
  resourceGroup,
  location: observed.location ?? "",
  provisioningState: observed.properties?.provisioningState,
  maxReadyCapacity: observed.properties?.elasticityProfile?.maxReadyCapacity,
  containerGroupProfileId:
    observed.properties?.containerGroupProperties?.containerGroupProfile?.id,
  containerGroupProfileRevision:
    observed.properties?.containerGroupProperties?.containerGroupProfile
      ?.revision,
  tags: userTags(observed.tags),
});

const toProperties = (
  props: ContainerGroupPoolProps,
): standbypool.StandbyContainerGroupPoolResourcePropertiesInput => ({
  elasticityProfile: {
    maxReadyCapacity: props.maxReadyCapacity,
    refillPolicy: props.refillPolicy ?? "always",
    ...(props.dynamicSizing !== undefined
      ? { dynamicSizing: { enabled: props.dynamicSizing } }
      : {}),
  },
  containerGroupProperties: {
    containerGroupProfile: {
      id: props.containerGroupProfileId,
      ...(props.containerGroupProfileRevision !== undefined
        ? { revision: props.containerGroupProfileRevision }
        : {}),
    },
    ...(props.subnetIds !== undefined
      ? { subnetIds: props.subnetIds.map((id) => ({ id })) }
      : {}),
  },
  ...(props.zones !== undefined ? { zones: props.zones } : {}),
});

/** Whether the observed pool spec matches the desired props. */
const specInSync = (
  props: ContainerGroupPoolProps,
  observed: standbypool.StandbyContainerGroupPoolResourceProperties | undefined,
) => {
  if (observed === undefined) return false;
  const elasticity = observed.elasticityProfile;
  const profile = observed.containerGroupProperties?.containerGroupProfile;
  return (
    elasticity?.maxReadyCapacity === props.maxReadyCapacity &&
    lower(elasticity?.refillPolicy ?? "always") ===
      lower(props.refillPolicy ?? "always") &&
    (props.dynamicSizing === undefined ||
      (elasticity?.dynamicSizing?.enabled ?? false) === props.dynamicSizing) &&
    lower(profile?.id) === lower(props.containerGroupProfileId) &&
    (props.containerGroupProfileRevision === undefined ||
      profile?.revision === props.containerGroupProfileRevision) &&
    (props.subnetIds === undefined ||
      sortedKey(props.subnetIds) ===
        sortedKey(
          observed.containerGroupProperties?.subnetIds?.map((s) => s.id),
        ))
  );
};

export const ContainerGroupPoolProvider = () =>
  Provider.succeed(ContainerGroupPool, {
    stables: [
      "standbyContainerGroupPoolName",
      "standbyContainerGroupPoolId",
      "resourceGroup",
      "location",
    ],

    list: Effect.fn(function* () {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const page = yield* standbypool
        .ListStandbyContainerGroupPoolBySubscription({ subscriptionId })
        .pipe(
          Effect.flatMap((page) =>
            requireSinglePage(
              "ListStandbyContainerGroupPoolBySubscription",
              page,
            ),
          ),
        );
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
        (news.name !== undefined &&
          lower(news.name) !== lower(output.standbyContainerGroupPoolName)) ||
        (news.location !== undefined &&
          !sameLocation(news.location, output.location)) ||
        sortedKey(news.zones) !== sortedKey(olds?.zones) ||
        (output.containerGroupProfileId !== undefined &&
          lower(news.containerGroupProfileId) !==
            lower(output.containerGroupProfileId))
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
        output?.standbyContainerGroupPoolName ??
        olds?.name ??
        (yield* createStandbyPoolName(id));
      const observed = yield* getPool(subscriptionId, resourceGroup, name);
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, name, observed);
      return (yield* isOwned(id, observed.tags)) ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* AzureEnvironment.current;
      const { subscriptionId } = env;
      yield* ensureRegistered(subscriptionId, "Microsoft.StandbyPool");
      const resourceGroup = news.resourceGroup;
      const name =
        news.name ??
        output?.standbyContainerGroupPoolName ??
        (yield* createStandbyPoolName(id));
      const location = news.location ?? output?.location ?? env.location;
      const tags = yield* desiredTags(id, news.tags);
      const get = getPool(subscriptionId, resourceGroup, name);

      // Observe.
      const observed = yield* get;

      // Ensure + sync. ARM replaces the spec and tag map on PUT, so any
      // observed drift is one full write followed by a provisioning wait.
      if (
        observed === undefined ||
        !specInSync(news, observed.properties) ||
        tagsDiffer(observed.tags, tags)
      ) {
        yield* standbypool.StandbyContainerGroupPoolsCreateOrUpdate({
          subscriptionId,
          resourceGroupName: resourceGroup,
          standbyContainerGroupPoolName: name,
          location,
          tags,
          properties: toProperties(news),
        });
      }

      const final = yield* waitForProvisioned(
        `standby container group pool ${name}`,
        get,
        (pool) => pool.properties?.provisioningState,
        { interval: "5 seconds", times: 120 },
      );
      return toAttrs(resourceGroup, name, final);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        standbypool.DeleteStandbyContainerGroupPool({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          standbyContainerGroupPoolName: output.standbyContainerGroupPoolName,
        }),
      );
      // Deleting the pool also deletes its pooled container groups.
      yield* waitUntilGone(
        `standby container group pool ${output.standbyContainerGroupPoolName}`,
        getPool(
          subscriptionId,
          output.resourceGroup,
          output.standbyContainerGroupPoolName,
        ),
        { interval: "5 seconds", times: 120 },
      );
    }),

    nuke: {
      dependsOn: [
        "Azure.Resources.ResourceGroup",
        "Azure.ContainerInstance.ContainerGroupProfile",
        "Azure.Network.Subnet",
      ],
    },
  });
