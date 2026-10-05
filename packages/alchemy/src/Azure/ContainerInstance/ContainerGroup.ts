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
  comparable,
  containerNames,
  containerResources,
  createContainerInstanceName,
  fingerprint,
  identityMatches,
  lower,
  matchesDesired,
  sameLocation,
  toContainers,
  toDiagnostics,
  toIdentity,
  toRegistryCredentials,
  type ContainerInstanceContainer,
  type ContainerInstanceIdentity,
  type ContainerInstanceIpAddress,
  type ContainerInstanceLogAnalytics,
  type ContainerInstanceRegistryCredential,
} from "./common.ts";

export type {
  ContainerInstanceContainer,
  ContainerInstanceIdentity,
  ContainerInstanceIpAddress,
  ContainerInstanceLogAnalytics,
  ContainerInstanceRegistryCredential,
} from "./common.ts";

export interface ContainerGroupProps {
  /** Resource group the container group is created in. Changing it replaces the group. */
  resourceGroup: string;
  /**
   * Container group name: 1-63 lowercase letters, digits, and hyphens. If
   * omitted, a unique name is generated from the app, stage, and logical
   * ID. Changing it replaces the group.
   */
  name?: string;
  /**
   * Azure location. Changing it replaces the group.
   * @default the `Azure.Location` layer, else the profile location, else `eastus`
   */
  location?: string;
  /** Availability zones to pin the group to. Changing them replaces the group. */
  zones?: string[];
  /**
   * Operating system of the containers. Changing it replaces the group.
   * @default "Linux"
   */
  osType?: "Linux" | "Windows";
  /**
   * SKU. `Confidential` runs in a confidential-computing enclave and
   * `Dedicated` on dedicated hosts; neither is available on every
   * subscription. Changing it replaces the group.
   * @default Azure's default (`Standard`)
   */
  sku?: "Standard" | "Dedicated" | "Confidential";
  /** Containers of the group. Changing the set of names or their CPU/memory replaces the group. */
  containers: ContainerInstanceContainer[];
  /** Init containers run to completion before the app containers. Changing them replaces the group. */
  initContainers?: aci.InitContainerDefinitionInput[];
  /**
   * Restart policy for all containers. Changing it replaces the group.
   * @default "Always"
   */
  restartPolicy?: "Always" | "OnFailure" | "Never";
  /** Public or private IP address of the group. */
  ipAddress?: ContainerInstanceIpAddress;
  /** Credentials for private image registries. */
  imageRegistryCredentials?: ContainerInstanceRegistryCredential[];
  /**
   * Volumes the containers can mount (Azure Files, emptyDir, secret, git
   * repo). Changing them replaces the group.
   */
  volumes?: aci.Volume[];
  /** Send container logs to a Log Analytics workspace. */
  logAnalytics?: ContainerInstanceLogAnalytics;
  /**
   * ARM IDs of subnets (delegated to `Microsoft.ContainerInstance/containerGroups`)
   * to inject the group into. Changing them replaces the group.
   */
  subnetIds?: string[];
  /** DNS configuration of the group. Changing it replaces the group. */
  dnsConfig?: aci.DnsConfiguration;
  /**
   * `Spot` runs on discounted, evictable capacity. Changing it replaces the group.
   * @default "Regular"
   */
  priority?: "Regular" | "Spot";
  /** Managed identity of the group. */
  identity?: ContainerInstanceIdentity;
  /**
   * User tags. Alchemy ownership tags (`alchemy::stack`, `alchemy::stage`,
   * `alchemy::id`) are merged in automatically.
   */
  tags?: Record<string, string>;
}

export interface ContainerGroup extends Resource<
  "Azure.ContainerInstance.ContainerGroup",
  ContainerGroupProps,
  {
    /** Name of the container group. */
    containerGroupName: string;
    /** ARM resource ID of the group; use it as a role-assignment scope. */
    containerGroupId: string;
    /** Resource group that holds the group. */
    resourceGroup: string;
    /** Location of the group. */
    location: string;
    /** IP address of the group, when it has one. */
    ip: string | undefined;
    /** FQDN of the group, when `ipAddress.dnsNameLabel` is set. */
    fqdn: string | undefined;
    /** Runtime state of the group, e.g. `Running`, `Succeeded`, `Stopped`. */
    state: string | undefined;
    /** Principal ID of the system-assigned identity, if enabled. */
    principalId: string | undefined;
    /** User tags (Alchemy ownership tags stripped). */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * An Azure Container Instances container group
 * (`Microsoft.ContainerInstance/containerGroups`) — one or more containers
 * scheduled together on the same host, sharing a network and volumes, and
 * billed per second.
 *
 * Deploys block until the group is provisioned. Changing an image,
 * command, environment, ports, or credentials re-deploys the group in
 * place (restarting its containers); changing the OS, SKU, restart policy,
 * container set, CPU/memory, volumes, or networking replaces it.
 *
 * @see https://learn.microsoft.com/azure/container-instances/container-instances-overview
 *
 * ### Creating a Container Group
 * **Example:** Public web server
 * ```typescript
 * const group = yield* Azure.Resources.ResourceGroup("app");
 * const web = yield* Azure.ContainerInstance.ContainerGroup("web", {
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
 * // web.ip serves HTTP on port 80
 * ```
 *
 * **Example:** Run-to-completion job
 * ```typescript
 * const job = yield* Azure.ContainerInstance.ContainerGroup("job", {
 *   resourceGroup: group.resourceGroupName,
 *   restartPolicy: "Never",
 *   containers: [
 *     {
 *       name: "job",
 *       image: "mcr.microsoft.com/azuredocs/aci-wordcount",
 *       cpu: 1,
 *       memoryInGB: 1,
 *     },
 *   ],
 * });
 * ```
 *
 * ### Environment Variables and Secrets
 * **Example:** Plain and secure environment variables
 * ```typescript
 * const api = yield* Azure.ContainerInstance.ContainerGroup("api", {
 *   resourceGroup: group.resourceGroupName,
 *   containers: [
 *     {
 *       name: "api",
 *       image: "myregistry.azurecr.io/api:1.0",
 *       environment: { MODE: "production" },
 *       secureEnvironment: { DB_PASSWORD: Redacted.make(password) },
 *     },
 *   ],
 *   imageRegistryCredentials: [
 *     {
 *       server: "myregistry.azurecr.io",
 *       username: "puller",
 *       password: Redacted.make(registryPassword),
 *     },
 *   ],
 * });
 * ```
 *
 * ### Identity
 * **Example:** System-assigned identity
 * ```typescript
 * const worker = yield* Azure.ContainerInstance.ContainerGroup("worker", {
 *   resourceGroup: group.resourceGroupName,
 *   identity: { type: "SystemAssigned" },
 *   containers: [{ name: "worker", image }],
 * });
 * // worker.principalId can now be granted roles
 * ```
 *
 * @resource
 */
export const ContainerGroup = Resource<ContainerGroup>(
  "Azure.ContainerInstance.ContainerGroup",
);

type ObservedGroup = aci.GetContainerGroupResponse;

const getGroup = (
  subscriptionId: string,
  resourceGroupName: string,
  containerGroupName: string,
) =>
  orUndefinedIfNotFound(
    aci.GetContainerGroup({
      subscriptionId,
      resourceGroupName,
      containerGroupName,
    }),
  );

const toAttrs = (
  resourceGroup: string,
  name: string,
  observed: Pick<
    ObservedGroup,
    "id" | "location" | "properties" | "identity" | "tags"
  >,
): ContainerGroup["Attributes"] => ({
  containerGroupName: name,
  containerGroupId: observed.id ?? "",
  resourceGroup,
  location: observed.location ?? "",
  ip: observed.properties?.ipAddress?.ip,
  fqdn: observed.properties?.ipAddress?.fqdn,
  state: observed.properties?.instanceView?.state,
  principalId: observed.identity?.principalId,
  tags: userTags(observed.tags),
});

/** The full PUT `properties` body (secret values revealed). */
const toProperties = (
  props: ContainerGroupProps,
): aci.ContainerGroupPropertiesPropertiesInput => ({
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
  subnetIds: props.subnetIds?.map((id) => ({ id })),
  dnsConfig: props.dnsConfig,
  priority: props.priority,
});

/** Previous-props fingerprint; secrets included so a rotated one re-deploys. */
const propsFingerprint = (props: ContainerGroupProps) =>
  fingerprint({ ...toProperties(props), identity: props.identity });

const sorted = (values: ReadonlyArray<string> | undefined) =>
  (values ?? [])
    .map((v) => v.toLowerCase())
    .sort()
    .join("|");

export const ContainerGroupProvider = () =>
  Provider.succeed(ContainerGroup, {
    stables: [
      "containerGroupName",
      "containerGroupId",
      "resourceGroup",
      "location",
    ],

    list: Effect.fn(function* () {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const page = yield* aci
        .ListContainerGroups({ subscriptionId })
        .pipe(
          Effect.flatMap((page) =>
            requireSinglePage("ListContainerGroups", page),
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
      const ip = news.ipAddress;
      const oldIp = olds.ipAddress;
      if (
        lower(news.resourceGroup) !== lower(output.resourceGroup) ||
        (news.name !== undefined && news.name !== output.containerGroupName) ||
        (news.location !== undefined &&
          !sameLocation(news.location, output.location)) ||
        sorted(news.zones) !== sorted(olds.zones) ||
        (news.osType ?? "Linux") !== (olds.osType ?? "Linux") ||
        (news.sku ?? "Standard") !== (olds.sku ?? "Standard") ||
        (news.restartPolicy ?? "Always") !== (olds.restartPolicy ?? "Always") ||
        (news.priority ?? "Regular") !== (olds.priority ?? "Regular") ||
        ip?.type !== oldIp?.type ||
        lower(ip?.dnsNameLabel) !== lower(oldIp?.dnsNameLabel) ||
        ip?.autoGeneratedDomainNameLabelScope !==
          oldIp?.autoGeneratedDomainNameLabelScope ||
        sorted(news.subnetIds) !== sorted(olds.subnetIds) ||
        fingerprint(news.dnsConfig ?? null) !==
          fingerprint(olds.dnsConfig ?? null) ||
        fingerprint(news.volumes ?? []) !== fingerprint(olds.volumes ?? []) ||
        fingerprint(news.initContainers ?? []) !==
          fingerprint(olds.initContainers ?? []) ||
        containerNames(news.containers) !== containerNames(olds.containers) ||
        containerResources(news.containers) !==
          containerResources(olds.containers)
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
        output?.containerGroupName ??
        olds?.name ??
        (yield* createContainerInstanceName(id));
      const observed = yield* getGroup(subscriptionId, resourceGroup, name);
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
        output?.containerGroupName ??
        (yield* createContainerInstanceName(id));
      const location = news.location ?? output?.location ?? env.location;
      const tags = yield* desiredTags(id, news.tags);
      const properties = toProperties(news);
      const where = {
        subscriptionId,
        resourceGroupName: resourceGroup,
        containerGroupName: name,
      };
      const get = getGroup(subscriptionId, resourceGroup, name);
      const ready = waitForProvisioned(
        `container group ${name}`,
        get,
        (group) => group.properties?.provisioningState,
        // Re-deploying a running group restarts it; observed 2-10 minutes.
        { interval: "10 seconds", times: 60 },
      );
      const put = aci.ContainerGroupsCreateOrUpdate({
        ...where,
        location,
        zones: news.zones,
        tags,
        identity: toIdentity(news.identity),
        properties,
      });

      // Observe.
      let observed = yield* get;

      // Ensure. The PUT carries the full desired state.
      if (observed === undefined) {
        yield* put;
        observed = yield* ready;
      } else {
        // Wait out an in-flight operation before comparing.
        observed = yield* ready;
        // Sync the spec: a re-PUT re-deploys (restarts) the containers, so
        // only send it when the observed spec or a secret drifted.
        const specInSync =
          matchesDesired(
            comparable(properties),
            comparable(observed.properties),
          ) &&
          identityMatches(news.identity, observed.identity) &&
          (olds === undefined ||
            propsFingerprint(news) === propsFingerprint(olds));
        if (!specInSync) {
          yield* put;
          observed = yield* ready;
        }
      }

      // Sync tags with a PATCH (no restart). A PUT of an existing group
      // does not always apply tag changes.
      if (tagsDiffer(observed.tags, tags)) {
        yield* aci.UpdateContainerGroup({ ...where, tags });
        observed = yield* ready;
      }

      return toAttrs(resourceGroup, name, observed);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        aci.DeleteContainerGroup({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          containerGroupName: output.containerGroupName,
        }),
      );
      yield* waitUntilGone(
        `container group ${output.containerGroupName}`,
        getGroup(
          subscriptionId,
          output.resourceGroup,
          output.containerGroupName,
        ),
        { interval: "5 seconds", times: 60 },
      );
    }),

    nuke: { dependsOn: ["Azure.Resources.ResourceGroup"] },
  });
