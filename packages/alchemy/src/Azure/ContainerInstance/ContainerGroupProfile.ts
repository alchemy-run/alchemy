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
  waitUntilGone,
} from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import {
  comparable,
  createContainerInstanceName,
  fingerprint,
  lower,
  matchesDesired,
  sameLocation,
  toContainers,
  toDiagnostics,
  toRegistryCredentials,
  type ContainerInstanceContainer,
  type ContainerInstanceIpAddress,
  type ContainerInstanceLogAnalytics,
  type ContainerInstanceRegistryCredential,
} from "./common.ts";

export interface ContainerGroupProfileProps {
  /** Resource group the profile is created in. Changing it replaces the profile. */
  resourceGroup: string;
  /**
   * Profile name: 1-63 lowercase letters, digits, and hyphens. If omitted, a
   * unique name is generated from the app, stage, and logical ID. Changing
   * it replaces the profile.
   */
  name?: string;
  /**
   * Azure location. Changing it replaces the profile.
   * @default the `Azure.Location` layer, else the profile location, else `eastus`
   */
  location?: string;
  /** Availability zones. Changing them replaces the profile. */
  zones?: string[];
  /**
   * Operating system of the containers.
   * @default "Linux"
   */
  osType?: "Linux" | "Windows";
  /**
   * SKU of container groups created from the profile.
   * @default Azure's default (`Standard`)
   */
  sku?: "Standard" | "Dedicated" | "Confidential";
  /** Containers of the template. */
  containers: ContainerInstanceContainer[];
  /** Init containers of the template. */
  initContainers?: aci.InitContainerDefinitionInput[];
  /**
   * Restart policy for all containers.
   * @default "Always"
   */
  restartPolicy?: "Always" | "OnFailure" | "Never";
  /** Public or private IP address of groups created from the profile. */
  ipAddress?: ContainerInstanceIpAddress;
  /** Credentials for private image registries. */
  imageRegistryCredentials?: ContainerInstanceRegistryCredential[];
  /** Volumes the containers can mount. */
  volumes?: aci.Volume[];
  /** Send container logs to a Log Analytics workspace. */
  logAnalytics?: ContainerInstanceLogAnalytics;
  /**
   * `Spot` runs on discounted, evictable capacity.
   * @default "Regular"
   */
  priority?: "Regular" | "Spot";
  /** Grace period before containers are killed on shutdown, as an ISO 8601 duration (e.g. `PT30S`). */
  shutdownGracePeriod?: string;
  /** Time-to-live of groups created from the profile, as an ISO 8601 duration. */
  timeToLive?: string;
  /**
   * User tags. Alchemy ownership tags (`alchemy::stack`, `alchemy::stage`,
   * `alchemy::id`) are merged in automatically.
   */
  tags?: Record<string, string>;
}

export interface ContainerGroupProfile extends Resource<
  "Azure.ContainerInstance.ContainerGroupProfile",
  ContainerGroupProfileProps,
  {
    /** Name of the profile. */
    containerGroupProfileName: string;
    /** ARM resource ID of the profile; reference it from container groups and NGroups. */
    containerGroupProfileId: string;
    /** Resource group that holds the profile. */
    resourceGroup: string;
    /** Location of the profile. */
    location: string;
    /** Current revision; every spec change creates a new revision. */
    revision: number | undefined;
    /** User tags (Alchemy ownership tags stripped). */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * An Azure Container Instances container group profile
 * (`Microsoft.ContainerInstance/containerGroupProfiles`) — a reusable,
 * revisioned container group template. It runs no compute itself; NGroups
 * and container groups are created from it.
 *
 * Every spec change creates a new `revision`; deploys only write when the
 * observed spec drifted.
 *
 * @see https://learn.microsoft.com/azure/container-instances/container-instance-ngroups/container-instances-about-ngroups
 *
 * ### Creating a Profile
 * **Example:** Web server template
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
 *       ports: [{ port: 80 }],
 *     },
 *   ],
 *   ipAddress: { type: "Public", ports: [{ port: 80, protocol: "TCP" }] },
 * });
 * ```
 *
 * ### Using a Profile
 * **Example:** Scale a profile with an NGroup
 * ```typescript
 * const fleet = yield* Azure.ContainerInstance.NGroup("fleet", {
 *   resourceGroup: group.resourceGroupName,
 *   desiredCount: 2,
 *   containerGroupProfiles: [
 *     { id: profile.containerGroupProfileId, revision: profile.revision },
 *   ],
 * });
 * ```
 *
 * @resource
 */
export const ContainerGroupProfile = Resource<ContainerGroupProfile>(
  "Azure.ContainerInstance.ContainerGroupProfile",
);

const getProfile = (
  subscriptionId: string,
  resourceGroupName: string,
  containerGroupProfileName: string,
) =>
  orUndefinedIfNotFound(
    aci.GetCGProfile({
      subscriptionId,
      resourceGroupName,
      containerGroupProfileName,
    }),
  );

const toAttrs = (
  resourceGroup: string,
  name: string,
  observed: Pick<
    aci.GetCGProfileResponse,
    "id" | "location" | "properties" | "tags"
  >,
): ContainerGroupProfile["Attributes"] => ({
  containerGroupProfileName: name,
  containerGroupProfileId: observed.id ?? "",
  resourceGroup,
  location: observed.location ?? "",
  revision: observed.properties?.revision,
  tags: userTags(observed.tags),
});

/** The full PUT `properties` body (secret values revealed). */
const toProperties = (
  props: ContainerGroupProfileProps,
): aci.ContainerGroupProfilePropertiesInput => ({
  containers: toContainers(props.containers),
  initContainers: props.initContainers,
  osType: props.osType ?? "Linux",
  sku: props.sku,
  restartPolicy: props.restartPolicy ?? "Always",
  ipAddress: props.ipAddress,
  imageRegistryCredentials: toRegistryCredentials(
    props.imageRegistryCredentials,
  ),
  volumes: props.volumes,
  diagnostics: toDiagnostics(props.logAnalytics),
  priority: props.priority,
  shutdownGracePeriod: props.shutdownGracePeriod,
  timeToLive: props.timeToLive,
});

const sorted = (values: ReadonlyArray<string> | undefined) =>
  (values ?? [])
    .map((v) => v.toLowerCase())
    .sort()
    .join("|");

export const ContainerGroupProfileProvider = () =>
  Provider.succeed(ContainerGroupProfile, {
    stables: [
      "containerGroupProfileName",
      "containerGroupProfileId",
      "resourceGroup",
      "location",
    ],

    list: Effect.fn(function* () {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const page = yield* aci
        .ListCGProfileBySubscription({ subscriptionId })
        .pipe(
          Effect.flatMap((page) =>
            requireSinglePage("ListCGProfileBySubscription", page),
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
          news.name !== output.containerGroupProfileName) ||
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
        output?.containerGroupProfileName ??
        olds?.name ??
        (yield* createContainerInstanceName(id));
      const observed = yield* getProfile(subscriptionId, resourceGroup, name);
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
        output?.containerGroupProfileName ??
        (yield* createContainerInstanceName(id));
      const location = news.location ?? output?.location ?? env.location;
      const tags = yield* desiredTags(id, news.tags);
      const properties = toProperties(news);
      const where = {
        subscriptionId,
        resourceGroupName: resourceGroup,
        containerGroupProfileName: name,
      };

      // Observe.
      const observed = yield* getProfile(subscriptionId, resourceGroup, name);

      // Ensure + sync the spec. The PUT is synchronous and creates a new
      // revision, so it is only sent when the profile is missing or its
      // observable spec (or a secret, against the previous props) drifted.
      const specInSync =
        observed !== undefined &&
        observed.properties !== undefined &&
        matchesDesired(
          comparable(properties),
          comparable(observed.properties),
        ) &&
        matchesDesired(
          {
            shutdownGracePeriod: properties.shutdownGracePeriod,
            timeToLive: properties.timeToLive,
          },
          observed.properties,
        ) &&
        (olds === undefined ||
          fingerprint(properties) === fingerprint(toProperties(olds)));
      if (observed === undefined || !specInSync) {
        const written = yield* aci.CGProfileCreateOrUpdate({
          ...where,
          location,
          zones: news.zones,
          tags,
          properties,
        });
        return toAttrs(resourceGroup, name, written);
      }

      // Sync tags alone with a PATCH.
      if (tagsDiffer(observed.tags, tags)) {
        const patched = yield* aci.UpdateCGProfile({ ...where, tags });
        return toAttrs(resourceGroup, name, {
          ...observed,
          tags: patched.tags ?? tags,
        });
      }

      return toAttrs(resourceGroup, name, observed);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        aci.DeleteCGProfile({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          containerGroupProfileName: output.containerGroupProfileName,
        }),
      );
      yield* waitUntilGone(
        `container group profile ${output.containerGroupProfileName}`,
        getProfile(
          subscriptionId,
          output.resourceGroup,
          output.containerGroupProfileName,
        ),
      );
    }),

    nuke: { dependsOn: ["Azure.Resources.ResourceGroup"] },
  });
