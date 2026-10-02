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
  createContainerAppsName,
  fingerprint,
  identityMatches,
  lower,
  matchesDesired,
  reveal,
  sameLocation,
  toIdentity,
  type ContainerAppsIdentity,
} from "./common.ts";

/** A secret available to custom-container sessions. */
export interface SessionPoolSecret {
  /** Secret name. */
  name: string;
  /** Secret value. */
  value: string | Redacted.Redacted<string>;
}

export interface SessionPoolProps {
  /** Resource group the pool is created in. Changing it replaces the pool. */
  resourceGroup: string;
  /**
   * Pool name: 2-32 lowercase letters, digits, and hyphens, starting with a
   * letter. If omitted, a unique name is generated from the app, stage, and
   * logical ID. Changing it replaces the pool.
   */
  name?: string;
  /**
   * Azure location. Changing it replaces the pool.
   * @default the `Azure.Location` layer, else the profile location, else `eastus`
   */
  location?: string;
  /**
   * Session type: `PythonLTS` (platform-managed code interpreter) or
   * `CustomContainer` (your image; requires `environmentId` and
   * `customContainerTemplate`). Changing it replaces the pool.
   */
  containerType: "PythonLTS" | "CustomContainer";
  /**
   * ARM ID of a workload profiles environment, required for custom
   * container pools. Changing it replaces the pool.
   */
  environmentId?: string;
  /**
   * How sessions are allocated. Changing it replaces the pool.
   * @default "Dynamic"
   */
  poolManagementType?: "Dynamic" | "Manual";
  /** Maximum concurrent sessions and pre-warmed ready instances. */
  scaleConfiguration?: app.ScaleConfiguration;
  /** Session lifecycle (cooldown or maximum alive period). */
  dynamicPoolConfiguration?: app.DynamicPoolConfiguration;
  /** Container, registry, and ingress of a custom container pool. */
  customContainerTemplate?: app.CustomContainerTemplate;
  /** Secrets available to custom container sessions. */
  secrets?: SessionPoolSecret[];
  /**
   * Whether sessions can reach the network (`EgressEnabled`) or not
   * (`EgressDisabled`).
   * @default Azure's default (`EgressDisabled`)
   */
  sessionNetworkStatus?: "EgressEnabled" | "EgressDisabled";
  /** Managed identities available inside sessions. */
  managedIdentitySettings?: app.ManagedIdentitySetting[];
  /** Managed identity of the pool. */
  identity?: ContainerAppsIdentity;
  /**
   * User tags. Alchemy ownership tags (`alchemy::stack`, `alchemy::stage`,
   * `alchemy::id`) are merged in automatically.
   */
  tags?: Record<string, string>;
}

export interface SessionPool extends Resource<
  "Azure.ContainerApps.SessionPool",
  SessionPoolProps,
  {
    /** Name of the session pool. */
    sessionPoolName: string;
    /** ARM resource ID; scope `Azure ContainerApps Session Executor` grants to it. */
    sessionPoolId: string;
    /** Resource group that holds the pool. */
    resourceGroup: string;
    /** Location of the pool. */
    location: string;
    /** Session type of the pool. */
    containerType: string;
    /** Data-plane endpoint for executing code in sessions. */
    poolManagementEndpoint: string | undefined;
    /** Principal ID of the system-assigned identity, if enabled. */
    principalId: string | undefined;
    /** User tags (Alchemy ownership tags stripped). */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * An Azure Container Apps session pool (`Microsoft.App/sessionPools`) —
 * dynamic sessions: isolated, pre-warmed sandboxes for running untrusted
 * code (Python code interpreter) or custom containers.
 *
 * @see https://learn.microsoft.com/azure/container-apps/sessions
 *
 * ### Code Interpreter
 * **Example:** Python code interpreter pool
 * ```typescript
 * const pool = yield* Azure.ContainerApps.SessionPool("interpreter", {
 *   resourceGroup: group.resourceGroupName,
 *   containerType: "PythonLTS",
 *   scaleConfiguration: { maxConcurrentSessions: 10, readySessionInstances: 1 },
 *   dynamicPoolConfiguration: {
 *     lifecycleConfiguration: {
 *       lifecycleType: "Timed",
 *       cooldownPeriodInSeconds: 300,
 *     },
 *   },
 * });
 * // POST code to `${pool.poolManagementEndpoint}/code/execute`
 * ```
 *
 * ### Custom Containers
 * **Example:** Pool running your own image
 * ```typescript
 * const pool = yield* Azure.ContainerApps.SessionPool("sandbox", {
 *   resourceGroup: group.resourceGroupName,
 *   containerType: "CustomContainer",
 *   environmentId: env.environmentId,
 *   scaleConfiguration: { maxConcurrentSessions: 5, readySessionInstances: 1 },
 *   customContainerTemplate: {
 *     containers: [
 *       {
 *         name: "sandbox",
 *         image: "mcr.microsoft.com/k8se/quickstart:latest",
 *         resources: { cpu: 0.25, memory: "0.5Gi" },
 *       },
 *     ],
 *     ingress: { targetPort: 80 },
 *   },
 * });
 * ```
 *
 * @resource
 */
export const SessionPool = Resource<SessionPool>(
  "Azure.ContainerApps.SessionPool",
);

const createPoolName = (id: string) => createContainerAppsName(id, 32);

const getPool = (
  subscriptionId: string,
  resourceGroupName: string,
  sessionPoolName: string,
) =>
  orUndefinedIfNotFound(
    app.GetContainerAppsSessionPool({
      subscriptionId,
      resourceGroupName,
      sessionPoolName,
    }),
  );

const toAttrs = (
  resourceGroup: string,
  name: string,
  observed: app.GetContainerAppsSessionPoolResponse,
): SessionPool["Attributes"] => ({
  sessionPoolName: name,
  sessionPoolId: observed.id ?? "",
  resourceGroup,
  location: observed.location,
  containerType: observed.properties?.containerType ?? "",
  poolManagementEndpoint: observed.properties?.poolManagementEndpoint,
  principalId: observed.identity?.principalId,
  tags: userTags(observed.tags),
});

/** The desired `properties` body (secret values revealed). */
const toProperties = (
  props: SessionPoolProps,
): app.SessionPoolPropertiesInput => ({
  environmentId: props.environmentId,
  containerType: props.containerType,
  poolManagementType: props.poolManagementType ?? "Dynamic",
  scaleConfiguration: props.scaleConfiguration,
  dynamicPoolConfiguration: props.dynamicPoolConfiguration,
  customContainerTemplate: props.customContainerTemplate,
  secrets: props.secrets?.map((secret) => ({
    name: secret.name,
    value: reveal(secret.value),
  })),
  sessionNetworkConfiguration:
    props.sessionNetworkStatus === undefined
      ? undefined
      : { status: props.sessionNetworkStatus },
  managedIdentitySettings: props.managedIdentitySettings,
});

export const SessionPoolProvider = () =>
  Provider.succeed(SessionPool, {
    stables: ["sessionPoolName", "sessionPoolId", "resourceGroup", "location"],

    list: Effect.fn(function* () {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const page = yield* app
        .ListContainerAppsSessionPoolBySubscription({ subscriptionId })
        .pipe(
          Effect.flatMap((page) =>
            requireSinglePage(
              "ListContainerAppsSessionPoolBySubscription",
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
        (news.name !== undefined && news.name !== output.sessionPoolName) ||
        (news.location !== undefined &&
          !sameLocation(news.location, output.location)) ||
        news.containerType !== output.containerType ||
        (olds !== undefined &&
          (lower(news.environmentId) !== lower(olds.environmentId) ||
            (news.poolManagementType ?? "Dynamic") !==
              (olds.poolManagementType ?? "Dynamic")))
      ) {
        // Pools hold only ephemeral sessions, names are unique per resource
        // group, and small subscriptions are capped at one pool: delete the
        // old pool before creating its replacement.
        return { action: "replace", deleteFirst: true } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      if (resourceGroup === undefined) return undefined;
      const name =
        output?.sessionPoolName ?? olds?.name ?? (yield* createPoolName(id));
      const observed = yield* getPool(subscriptionId, resourceGroup, name);
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, name, observed);
      return (yield* isOwned(id, observed.tags)) ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, olds, output }) {
      const env = yield* AzureEnvironment.current;
      const { subscriptionId } = env;
      yield* ensureRegistered(subscriptionId, "Microsoft.App");
      const resourceGroup = news.resourceGroup;
      const name =
        news.name ?? output?.sessionPoolName ?? (yield* createPoolName(id));
      const location = news.location ?? output?.location ?? env.location;
      const tags = yield* desiredTags(id, news.tags);
      const properties = toProperties(news);
      const get = getPool(subscriptionId, resourceGroup, name);
      const put = app.ContainerAppsSessionPoolsCreateOrUpdate({
        subscriptionId,
        resourceGroupName: resourceGroup,
        sessionPoolName: name,
        location,
        tags,
        identity: toIdentity(news.identity),
        properties,
      });
      const ready = waitForProvisioned(
        `session pool ${name}`,
        get,
        (pool) => pool.properties?.provisioningState,
        { interval: "5 seconds", times: 60 },
      );

      // Observe.
      let observed = yield* get;

      // Ensure. The PUT carries the full desired state.
      if (observed === undefined) {
        yield* put;
        observed = yield* ready;
      } else {
        observed = yield* ready;
        // Sync. Secret values are never echoed back: compare names against
        // the observed pool and values against the previous props.
        const inSync =
          matchesDesired(
            {
              ...properties,
              secrets: properties.secrets?.map((s) => ({ name: s.name })),
            },
            observed.properties,
          ) &&
          identityMatches(news.identity, observed.identity) &&
          !tagsDiffer(observed.tags, tags) &&
          (olds === undefined ||
            fingerprint(properties) === fingerprint(toProperties(olds)));
        if (!inSync) {
          yield* put;
          observed = yield* ready;
        }
      }

      return toAttrs(resourceGroup, name, observed);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        app.DeleteContainerAppsSessionPool({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          sessionPoolName: output.sessionPoolName,
        }),
      );
      yield* waitUntilGone(
        `session pool ${output.sessionPoolName}`,
        getPool(subscriptionId, output.resourceGroup, output.sessionPoolName),
        { interval: "5 seconds", times: 60 },
      );
    }),

    nuke: {
      dependsOn: [
        "Azure.ContainerApps.ManagedEnvironment",
        "Azure.Resources.ResourceGroup",
      ],
    },
  });
