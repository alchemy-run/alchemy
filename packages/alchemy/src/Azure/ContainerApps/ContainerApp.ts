import * as app from "@distilled.cloud/azure/app";
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
  createContainerAppsName,
  fingerprint,
  getContainerApp,
  identityMatches,
  lower,
  matchesDesired,
  sameLocation,
  secretsMatch,
  toIdentity,
  toSecrets,
  type ContainerAppsIdentity,
  type ContainerAppsSecret,
} from "./common.ts";

export type { ContainerAppsIdentity, ContainerAppsSecret } from "./common.ts";

/**
 * App-level configuration: ingress, revision mode, registries, Dapr,
 * runtime settings. Secrets are set with the separate `secrets` prop.
 */
export type ContainerAppConfiguration = Omit<app.ConfigurationInput, "secrets">;

/** Versioned template: containers, scale rules, volumes. */
export type ContainerAppTemplate = app.TemplateInput;

export interface ContainerAppProps {
  /** Resource group the app is created in. Changing it replaces the app. */
  resourceGroup: string;
  /**
   * App name: 2-32 lowercase letters, digits, and hyphens, starting with a
   * letter and without `--`. If omitted, a unique name is generated from the
   * app, stage, and logical ID. Changing it replaces the app.
   */
  name?: string;
  /**
   * Azure location; must match the environment's location. Changing it
   * replaces the app.
   * @default the `Azure.Location` layer, else the profile location, else `eastus`
   */
  location?: string;
  /**
   * ARM ID of the Container Apps environment (`environment.environmentId`).
   * Changing it replaces the app.
   */
  environmentId: string;
  /**
   * Workload profile of the environment to run on.
   * @default the environment's Consumption profile
   */
  workloadProfileName?: string;
  /** App-level configuration (ingress, revision mode, registries, Dapr). */
  configuration?: ContainerAppConfiguration;
  /**
   * Revision template: containers, scale, and volumes. Changing it
   * creates a new revision.
   */
  template: ContainerAppTemplate;
  /**
   * Secrets referenced by env vars (`secretRef`), registries
   * (`passwordSecretRef`), and scale rules.
   */
  secrets?: ContainerAppsSecret[];
  /** Managed identity of the app. */
  identity?: ContainerAppsIdentity;
  /**
   * User tags. Alchemy ownership tags (`alchemy::stack`, `alchemy::stage`,
   * `alchemy::id`) are merged in automatically.
   */
  tags?: Record<string, string>;
}

export interface ContainerApp extends Resource<
  "Azure.ContainerApps.ContainerApp",
  ContainerAppProps,
  {
    /** Name of the container app. */
    containerAppName: string;
    /** ARM resource ID of the app; use it as a role-assignment scope. */
    containerAppId: string;
    /** Resource group that holds the app. */
    resourceGroup: string;
    /** Location of the app. */
    location: string;
    /** ARM ID of the environment the app runs in. */
    environmentId: string;
    /** Ingress FQDN, when ingress is enabled. */
    fqdn: string | undefined;
    /** `https://{fqdn}`, when ingress is enabled. */
    url: string | undefined;
    /** Name of the latest revision. */
    latestRevisionName: string | undefined;
    /** Name of the latest revision that is ready. */
    latestReadyRevisionName: string | undefined;
    /** Outbound IP addresses of the app. */
    outboundIpAddresses: string[];
    /** ID to put in the `asuid` TXT record when binding a custom domain. */
    customDomainVerificationId: string | undefined;
    /** Principal ID of the system-assigned identity, if enabled. */
    principalId: string | undefined;
    /** User tags (Alchemy ownership tags stripped). */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * An Azure Container App (`Microsoft.App/containerApps`) — a serverless
 * container service with revisions, HTTP ingress, and scale-to-zero, hosted
 * in a `ManagedEnvironment`.
 *
 * Deploys block until the latest revision is ready.
 *
 * @see https://learn.microsoft.com/azure/container-apps/overview
 *
 * ### Creating a Container App
 * **Example:** Public HTTP app that scales to zero
 * ```typescript
 * const env = yield* Azure.ContainerApps.ManagedEnvironment("env", {
 *   resourceGroup: group.resourceGroupName,
 * });
 * const api = yield* Azure.ContainerApps.ContainerApp("api", {
 *   resourceGroup: group.resourceGroupName,
 *   environmentId: env.environmentId,
 *   configuration: { ingress: { external: true, targetPort: 80 } },
 *   template: {
 *     containers: [
 *       {
 *         name: "api",
 *         image: "mcr.microsoft.com/k8se/quickstart:latest",
 *         resources: { cpu: 0.25, memory: "0.5Gi" },
 *       },
 *     ],
 *     scale: { minReplicas: 0, maxReplicas: 1 },
 *   },
 * });
 * ```
 *
 * ### Secrets and Environment Variables
 * **Example:** Reference a secret from an env var
 * ```typescript
 * const api = yield* Azure.ContainerApps.ContainerApp("api", {
 *   resourceGroup: group.resourceGroupName,
 *   environmentId: env.environmentId,
 *   secrets: [{ name: "db-password", value: Redacted.make(password) }],
 *   template: {
 *     containers: [
 *       {
 *         name: "api",
 *         image: "mcr.microsoft.com/k8se/quickstart:latest",
 *         env: [
 *           { name: "MODE", value: "production" },
 *           { name: "DB_PASSWORD", secretRef: "db-password" },
 *         ],
 *       },
 *     ],
 *   },
 * });
 * ```
 *
 * ### Identity
 * **Example:** System-assigned identity
 * ```typescript
 * const api = yield* Azure.ContainerApps.ContainerApp("api", {
 *   resourceGroup: group.resourceGroupName,
 *   environmentId: env.environmentId,
 *   identity: { type: "SystemAssigned" },
 *   template: { containers: [{ name: "api", image }] },
 * });
 * // api.principalId can now be granted roles
 * ```
 *
 * @resource
 */
export const ContainerApp = Resource<ContainerApp>(
  "Azure.ContainerApps.ContainerApp",
);

const createAppName = (id: string) => createContainerAppsName(id, 32);

const toAttrs = (
  resourceGroup: string,
  name: string,
  observed: app.GetContainerAppResponse,
): ContainerApp["Attributes"] => {
  const props = observed.properties;
  const fqdn = props?.configuration?.ingress?.fqdn;
  return {
    containerAppName: name,
    containerAppId: observed.id ?? "",
    resourceGroup,
    location: observed.location,
    environmentId: props?.managedEnvironmentId ?? props?.environmentId ?? "",
    fqdn,
    url: fqdn ? `https://${fqdn}` : undefined,
    latestRevisionName: props?.latestRevisionName,
    latestReadyRevisionName: props?.latestReadyRevisionName,
    outboundIpAddresses: [...(props?.outboundIpAddresses ?? [])],
    customDomainVerificationId: props?.customDomainVerificationId,
    principalId: observed.identity?.principalId,
    tags: userTags(observed.tags),
  };
};

/** The desired `properties` body (secret values revealed). */
const toProperties = (
  props: ContainerAppProps,
): app.ContainerAppPropertiesInput => ({
  managedEnvironmentId: props.environmentId,
  workloadProfileName: props.workloadProfileName,
  configuration: { ...props.configuration, secrets: toSecrets(props.secrets) },
  template: props.template,
});

/**
 * Ready once provisioning succeeded and the latest revision is ready, so
 * callers can route traffic as soon as the deploy returns.
 */
const appState = (observed: app.GetContainerAppResponse) => {
  const props = observed.properties;
  const state = props?.provisioningState ?? "InProgress";
  if (state !== "Succeeded") return state;
  return props?.latestRevisionName !== undefined &&
    props.latestReadyRevisionName !== props.latestRevisionName
    ? "RevisionProvisioning"
    : "Succeeded";
};

export const ContainerAppProvider = () =>
  Provider.succeed(ContainerApp, {
    stables: [
      "containerAppName",
      "containerAppId",
      "resourceGroup",
      "location",
      "customDomainVerificationId",
    ],

    list: Effect.fn(function* () {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const page = yield* app
        .ListContainerAppBySubscription({ subscriptionId })
        .pipe(
          Effect.flatMap((page) =>
            requireSinglePage("ListContainerAppBySubscription", page),
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

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        lower(news.resourceGroup) !== lower(output.resourceGroup) ||
        (news.name !== undefined && news.name !== output.containerAppName) ||
        (news.location !== undefined &&
          !sameLocation(news.location, output.location)) ||
        lower(news.environmentId) !== lower(output.environmentId)
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
        output?.containerAppName ?? olds?.name ?? (yield* createAppName(id));
      const observed = yield* getContainerApp(
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
      const resourceGroup = news.resourceGroup;
      const name =
        news.name ?? output?.containerAppName ?? (yield* createAppName(id));
      const location = news.location ?? output?.location ?? env.location;
      const tags = yield* desiredTags(id, news.tags);
      const properties = toProperties(news);
      const where = {
        subscriptionId,
        resourceGroupName: resourceGroup,
        containerAppName: name,
      };
      const get = getContainerApp(subscriptionId, resourceGroup, name);
      const put = app.ContainerAppsCreateOrUpdate({
        ...where,
        location,
        tags,
        identity: toIdentity(news.identity),
        properties,
      });
      const ready = waitForProvisioned(`container app ${name}`, get, appState, {
        interval: "5 seconds",
        times: 60,
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
        // Sync. ARM echoes defaults back, so compare the desired subset;
        // secret values are only observable through `listSecrets`, and
        // removed properties only against the previous props.
        const secrets = toSecrets(news.secrets);
        const configuration = news.configuration;
        const observedSecrets =
          secrets.length > 0 ||
          (observed.properties?.configuration?.secrets ?? []).length > 0
            ? (yield* orUndefinedIfNotFound(app.ListContainerAppSecrets(where)))
                ?.value
            : [];
        const inSync =
          matchesDesired(
            { ...properties, configuration },
            observed.properties,
          ) &&
          secretsMatch(secrets, observedSecrets) &&
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
        app.DeleteContainerApp({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          containerAppName: output.containerAppName,
        }),
      );
      yield* waitUntilGone(
        `container app ${output.containerAppName}`,
        getContainerApp(
          subscriptionId,
          output.resourceGroup,
          output.containerAppName,
        ),
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
