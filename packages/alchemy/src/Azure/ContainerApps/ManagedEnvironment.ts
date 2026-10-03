import * as app from "@distilled.cloud/azure/app";
import * as Effect from "effect/Effect";
import type * as Redacted from "effect/Redacted";
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
  ProvisioningFailed,
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
  createContainerAppsName,
  fingerprint,
  getEnvironment,
  identityMatches,
  lower,
  matchesDesired,
  reveal,
  sameLocation,
  toIdentity,
  type ContainerAppsIdentity,
} from "./common.ts";

/** A workload profile of a Container Apps environment. */
export interface ManagedEnvironmentWorkloadProfile {
  /** Profile name, referenced by apps' `workloadProfileName`. */
  name: string;
  /**
   * Profile type: `Consumption` (serverless, no reserved cores) or a
   * dedicated type such as `D4` or `E4`. Dedicated profiles count against
   * the regional vCPU quota.
   */
  workloadProfileType: string;
  /** Minimum node count of a dedicated profile. */
  minimumCount?: number;
  /** Maximum node count of a dedicated profile. */
  maximumCount?: number;
}

/** Where the environment ships container console and system logs. */
export interface ManagedEnvironmentLogs {
  /**
   * Log destination: `log-analytics` (requires `logAnalyticsConfiguration`)
   * or `azure-monitor` (configure diagnostic settings separately).
   */
  destination: "log-analytics" | "azure-monitor";
  /** Log Analytics workspace to stream logs to. */
  logAnalyticsConfiguration?: {
    /** Workspace ID (`customerId`) of the Log Analytics workspace. */
    customerId: string;
    /** Primary shared key of the workspace. */
    sharedKey: string | Redacted.Redacted<string>;
  };
}

/** Virtual network integration of the environment (immutable). */
export interface ManagedEnvironmentVnet {
  /** ARM ID of the infrastructure subnet (delegated to `Microsoft.App/environments`). */
  infrastructureSubnetId?: string;
  /** Expose apps only on the virtual network (internal load balancer). */
  internal?: boolean;
  /** CIDR for the Docker bridge network. */
  dockerBridgeCidr?: string;
  /** CIDR reserved for platform infrastructure. */
  platformReservedCidr?: string;
  /** IP of the platform DNS server inside `platformReservedCidr`. */
  platformReservedDnsIP?: string;
}

export interface ManagedEnvironmentProps {
  /**
   * Resource group the environment is created in. Changing it replaces the
   * environment.
   */
  resourceGroup: string;
  /**
   * Environment name: 2-60 lowercase letters, digits, and hyphens, starting
   * with a letter. If omitted, a unique name is generated from the app,
   * stage, and logical ID. Changing it replaces the environment.
   */
  name?: string;
  /**
   * Azure location of the environment. Changing it replaces the
   * environment.
   * @default the `Azure.Location` layer, else the profile location, else `eastus`
   */
  location?: string;
  /**
   * Environment tier. `Express` is a fully managed, fast-provisioning tier
   * for HTTP apps (no jobs, Dapr, Easy Auth, custom domains, workload
   * profiles, or Azure Files mounts). Changing it replaces the environment.
   * @default Azure's default (`WorkloadProfiles`)
   */
  environmentMode?: "ConsumptionOnly" | "WorkloadProfiles" | "Express";
  /**
   * Workload profiles of a `WorkloadProfiles` environment. Include a
   * `Consumption` profile for serverless apps.
   */
  workloadProfiles?: ManagedEnvironmentWorkloadProfile[];
  /**
   * Log destination for container console and system logs.
   * @default no log destination
   */
  appLogsConfiguration?: ManagedEnvironmentLogs;
  /**
   * Virtual network integration. Changing it replaces the environment.
   */
  vnetConfiguration?: ManagedEnvironmentVnet;
  /**
   * Spread replicas across availability zones (requires
   * `vnetConfiguration`). Changing it replaces the environment.
   * @default false
   */
  zoneRedundant?: boolean;
  /**
   * Name of the platform-managed resource group for a workload profiles
   * environment. Changing it replaces the environment.
   * @default `ME_{name}_{resourceGroup}_{location}`
   */
  infrastructureResourceGroup?: string;
  /**
   * Enable mutual TLS between apps in the environment.
   * @default Azure's default (`false`)
   */
  mtlsEnabled?: boolean;
  /**
   * Encrypt peer traffic between apps in the environment.
   * @default Azure's default (`false`)
   */
  peerTrafficEncryptionEnabled?: boolean;
  /**
   * Whether the environment accepts traffic from the public internet.
   * @default Azure's default (`Enabled`)
   */
  publicNetworkAccess?: "Enabled" | "Disabled";
  /** Managed identity of the environment. */
  identity?: ContainerAppsIdentity;
  /**
   * User tags. Alchemy ownership tags (`alchemy::stack`, `alchemy::stage`,
   * `alchemy::id`) are merged in automatically.
   */
  tags?: Record<string, string>;
}

export interface ManagedEnvironment extends Resource<
  "Azure.ContainerApps.ManagedEnvironment",
  ManagedEnvironmentProps,
  {
    /** Name of the environment. */
    environmentName: string;
    /** ARM resource ID; pass it as `environmentId` to apps and jobs. */
    environmentId: string;
    /** Resource group that holds the environment. */
    resourceGroup: string;
    /** Location of the environment. */
    location: string;
    /** Environment tier (`WorkloadProfiles`, `ConsumptionOnly`, `Express`). */
    environmentMode: string | undefined;
    /** Default domain of apps in the environment, e.g. `{hash}.eastus.azurecontainerapps.io`. */
    defaultDomain: string | undefined;
    /** Static IP address of the environment. */
    staticIp: string | undefined;
    /** Event stream endpoint of the environment. */
    eventStreamEndpoint: string | undefined;
    /** Platform-managed resource group (workload profiles environments). */
    infrastructureResourceGroup: string | undefined;
    /** Principal ID of the system-assigned identity, if enabled. */
    principalId: string | undefined;
    /** User tags (Alchemy ownership tags stripped). */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * An Azure Container Apps environment (`Microsoft.App/managedEnvironments`)
 * — the shared network and logging boundary that container apps, jobs,
 * Dapr components, and storages live in.
 *
 * Creating a standard environment takes 3-6 minutes; deleting one 2-5
 * minutes (10+ minutes after a failed create). An `Express` environment
 * provisions in seconds. Environments cost nothing while idle. New
 * subscriptions may be limited to one standard environment per region.
 *
 * @see https://learn.microsoft.com/azure/container-apps/environment
 *
 * ### Creating an Environment
 * **Example:** Workload profiles environment with a Consumption profile
 * ```typescript
 * const group = yield* Azure.Resources.ResourceGroup("app");
 * const env = yield* Azure.ContainerApps.ManagedEnvironment("env", {
 *   resourceGroup: group.resourceGroupName,
 *   workloadProfiles: [
 *     { name: "Consumption", workloadProfileType: "Consumption" },
 *   ],
 * });
 * ```
 *
 * **Example:** Express environment for HTTP apps
 * ```typescript
 * const env = yield* Azure.ContainerApps.ManagedEnvironment("env", {
 *   resourceGroup: group.resourceGroupName,
 *   environmentMode: "Express",
 * });
 * ```
 *
 * ### Logging
 * **Example:** Stream logs to a Log Analytics workspace
 * ```typescript
 * const env = yield* Azure.ContainerApps.ManagedEnvironment("env", {
 *   resourceGroup: group.resourceGroupName,
 *   appLogsConfiguration: {
 *     destination: "log-analytics",
 *     logAnalyticsConfiguration: {
 *       customerId: workspaceId,
 *       sharedKey: Redacted.make(workspaceKey),
 *     },
 *   },
 * });
 * ```
 *
 * ### Security
 * **Example:** Mutual TLS between apps
 * ```typescript
 * const env = yield* Azure.ContainerApps.ManagedEnvironment("env", {
 *   resourceGroup: group.resourceGroupName,
 *   mtlsEnabled: true,
 * });
 * ```
 *
 * @resource
 */
export const ManagedEnvironment = Resource<ManagedEnvironment>(
  "Azure.ContainerApps.ManagedEnvironment",
);

const createEnvironmentName = (id: string) => createContainerAppsName(id, 60);

const toAttrs = (
  resourceGroup: string,
  name: string,
  env: app.GetManagedEnvironmentResponse,
): ManagedEnvironment["Attributes"] => ({
  environmentName: name,
  environmentId: env.id ?? "",
  resourceGroup,
  location: env.location,
  environmentMode: env.properties?.environmentMode,
  defaultDomain: env.properties?.defaultDomain,
  staticIp: env.properties?.staticIp,
  eventStreamEndpoint: env.properties?.eventStreamEndpoint,
  infrastructureResourceGroup: env.properties?.infrastructureResourceGroup,
  principalId: env.identity?.principalId,
  tags: userTags(env.tags),
});

/** Properties that can be changed in place (secrets revealed). */
const mutableProperties = (
  props: ManagedEnvironmentProps,
): app.ManagedEnvironmentPropertiesInput => ({
  workloadProfiles: props.workloadProfiles,
  appLogsConfiguration:
    props.appLogsConfiguration === undefined
      ? undefined
      : {
          destination: props.appLogsConfiguration.destination,
          logAnalyticsConfiguration:
            props.appLogsConfiguration.logAnalyticsConfiguration === undefined
              ? undefined
              : {
                  customerId:
                    props.appLogsConfiguration.logAnalyticsConfiguration
                      .customerId,
                  sharedKey: reveal(
                    props.appLogsConfiguration.logAnalyticsConfiguration
                      .sharedKey,
                  ),
                },
        },
  peerAuthentication:
    props.mtlsEnabled === undefined
      ? undefined
      : { mtls: { enabled: props.mtlsEnabled } },
  peerTrafficConfiguration:
    props.peerTrafficEncryptionEnabled === undefined
      ? undefined
      : { encryption: { enabled: props.peerTrafficEncryptionEnabled } },
  publicNetworkAccess: props.publicNetworkAccess,
});

/** The mutable properties ARM echoes back (the shared key never is). */
const observableProperties = (
  properties: app.ManagedEnvironmentPropertiesInput,
) => ({
  ...properties,
  appLogsConfiguration:
    properties.appLogsConfiguration === undefined
      ? undefined
      : {
          destination: properties.appLogsConfiguration.destination,
          logAnalyticsConfiguration:
            properties.appLogsConfiguration.logAnalyticsConfiguration ===
            undefined
              ? undefined
              : {
                  customerId:
                    properties.appLogsConfiguration.logAnalyticsConfiguration
                      .customerId,
                },
        },
});

/**
 * Poll until the environment is provisioned. A failed environment carries
 * the platform's reason in `deploymentErrors`; surface it.
 */
const provisioned = (label: string, get: ReturnType<typeof getEnvironment>) =>
  waitForProvisioned(label, get, (env) => env.properties?.provisioningState, {
    interval: "10 seconds",
    times: 60,
  }).pipe(
    Effect.catchTag("Azure.ProvisioningFailed", (failure) =>
      get.pipe(
        Effect.flatMap((env) =>
          Effect.fail(
            new ProvisioningFailed({
              resource: failure.resource,
              state: failure.state,
              message: `${failure.message}: ${env?.properties?.deploymentErrors ?? "no deployment errors reported"}`,
            }),
          ),
        ),
      ),
    ),
  );

export const ManagedEnvironmentProvider = () =>
  Provider.succeed(ManagedEnvironment, {
    stables: ["environmentName", "environmentId", "resourceGroup", "location"],

    list: Effect.fn(function* () {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const page = yield* app
        .ListManagedEnvironmentBySubscription({ subscriptionId })
        .pipe(
          Effect.flatMap((page) =>
            requireSinglePage("ListManagedEnvironmentBySubscription", page),
          ),
        );
      return (page.value ?? []).flatMap((env) => {
        const group = resourceGroupOf(env.id);
        return hasAnyAlchemyTag(env.tags) &&
          group !== undefined &&
          env.name !== undefined
          ? [toAttrs(group, env.name, env)]
          : [];
      });
    }),

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        lower(news.resourceGroup) !== lower(output.resourceGroup) ||
        (news.name !== undefined && news.name !== output.environmentName) ||
        (news.location !== undefined &&
          !sameLocation(news.location, output.location)) ||
        (olds !== undefined &&
          (fingerprint(news.vnetConfiguration) !==
            fingerprint(olds.vnetConfiguration) ||
            (news.zoneRedundant ?? false) !== (olds.zoneRedundant ?? false) ||
            lower(news.environmentMode) !== lower(olds.environmentMode) ||
            lower(news.infrastructureResourceGroup) !==
              lower(olds.infrastructureResourceGroup)))
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
        output?.environmentName ??
        olds?.name ??
        (yield* createEnvironmentName(id));
      const observed = yield* getEnvironment(
        subscriptionId,
        resourceGroup,
        name,
      );
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, name, observed);
      return (yield* isOwned(id, observed.tags)) ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, olds, output }) {
      const env = yield* AzureEnvironment.current;
      const { subscriptionId } = env;
      yield* ensureRegistered(subscriptionId, "Microsoft.App");
      // Environments run on platform-managed AKS clusters; an unregistered
      // `Microsoft.ContainerService` fails provisioning asynchronously.
      yield* ensureRegistered(subscriptionId, "Microsoft.ContainerService");
      const resourceGroup = news.resourceGroup;
      const name =
        news.name ??
        output?.environmentName ??
        (yield* createEnvironmentName(id));
      const location = news.location ?? output?.location ?? env.location;
      const tags = yield* desiredTags(id, news.tags);
      const identity = toIdentity(news.identity);
      const mutable = mutableProperties(news);
      const where = {
        subscriptionId,
        resourceGroupName: resourceGroup,
        environmentName: name,
      };
      const label = `container apps environment ${name}`;
      const get = getEnvironment(subscriptionId, resourceGroup, name);

      // Observe.
      let observed = yield* get;

      // Ensure. The PUT is a long-running operation; poll until terminal.
      if (observed === undefined) {
        yield* app.ManagedEnvironmentsCreateOrUpdate({
          ...where,
          location,
          tags,
          identity,
          properties: {
            ...mutable,
            environmentMode: news.environmentMode,
            vnetConfiguration: news.vnetConfiguration,
            zoneRedundant: news.zoneRedundant,
            infrastructureResourceGroup: news.infrastructureResourceGroup,
          },
        });
      }
      observed = yield* provisioned(label, get);

      // Sync mutable properties, identity, and tags against the observed
      // environment. Secrets (the Log Analytics key) are not echoed back,
      // so a changed key is detected against the previous props.
      const propertiesChanged =
        !matchesDesired(observableProperties(mutable), observed.properties) ||
        (olds !== undefined &&
          fingerprint(mutable) !== fingerprint(mutableProperties(olds)));
      const identityChanged = !identityMatches(
        news.identity,
        observed.identity,
      );
      const tagsChanged = tagsDiffer(observed.tags, tags);
      if (propertiesChanged || identityChanged || tagsChanged) {
        yield* app.UpdateManagedEnvironment({
          ...where,
          location: observed.location,
          tags,
          identity: identityChanged ? identity : undefined,
          properties: propertiesChanged ? mutable : undefined,
        });
        observed = yield* provisioned(label, get);
      }

      return toAttrs(resourceGroup, name, observed);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        app.DeleteManagedEnvironment({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          environmentName: output.environmentName,
        }),
      );
      yield* waitUntilGone(
        `container apps environment ${output.environmentName}`,
        getEnvironment(
          subscriptionId,
          output.resourceGroup,
          output.environmentName,
        ),
        // Environment deletes regularly take 5-25 minutes (longer after a
        // failed create, which sits in `ScheduledForDelete`).
        { interval: "10 seconds", times: 180 },
      );
    }),

    nuke: { dependsOn: ["Azure.Resources.ResourceGroup"] },
  });
