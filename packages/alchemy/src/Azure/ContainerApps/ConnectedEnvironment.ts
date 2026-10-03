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
  lower,
  matchesDesired,
  reveal,
  sameLocation,
} from "./common.ts";

export interface ConnectedEnvironmentProps {
  /** Resource group the environment is created in. Changing it replaces the environment. */
  resourceGroup: string;
  /**
   * Environment name: lowercase letters, digits, and hyphens. If omitted, a
   * unique name is generated from the app, stage, and logical ID. Changing
   * it replaces the environment.
   */
  name?: string;
  /**
   * Azure location of the custom location's cluster. Changing it replaces
   * the environment.
   * @default the `Azure.Location` layer, else the profile location, else `eastus`
   */
  location?: string;
  /**
   * ARM ID of the Azure Arc custom location
   * (`Microsoft.ExtendedLocation/customLocations`) on an Arc-enabled
   * Kubernetes cluster with the Container Apps extension. Changing it
   * replaces the environment.
   */
  customLocationId: string;
  /** Static IP of the environment's ingress. Changing it replaces the environment. */
  staticIp?: string;
  /** Application Insights connection string Dapr exports telemetry to. */
  daprAIConnectionString?: string | Redacted.Redacted<string>;
  /** Custom DNS suffix and its certificate. */
  customDomainConfiguration?: app.CustomDomainConfigurationInput;
  /**
   * User tags. Alchemy ownership tags (`alchemy::stack`, `alchemy::stage`,
   * `alchemy::id`) are merged in automatically.
   */
  tags?: Record<string, string>;
}

export interface ConnectedEnvironment extends Resource<
  "Azure.ContainerApps.ConnectedEnvironment",
  ConnectedEnvironmentProps,
  {
    /** Name of the environment. */
    environmentName: string;
    /** ARM resource ID of the environment. */
    environmentId: string;
    /** Resource group that holds the environment. */
    resourceGroup: string;
    /** Location of the environment. */
    location: string;
    /** ARM ID of the custom location. */
    customLocationId: string | undefined;
    /** Default domain of the environment. */
    defaultDomain: string | undefined;
    /** Static IP of the environment. */
    staticIp: string | undefined;
    /** User tags (Alchemy ownership tags stripped). */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * An Azure Container Apps connected environment
 * (`Microsoft.App/connectedEnvironments`) — a Container Apps environment
 * running on your own Azure Arc-enabled Kubernetes cluster, addressed
 * through an Arc custom location.
 *
 * @see https://learn.microsoft.com/azure/container-apps/azure-arc-overview
 *
 * ### Arc-Enabled Kubernetes
 * **Example:** Environment on a custom location
 * ```typescript
 * const env = yield* Azure.ContainerApps.ConnectedEnvironment("arc", {
 *   resourceGroup: group.resourceGroupName,
 *   location: "eastus",
 *   customLocationId: customLocation.id,
 *   staticIp: "20.1.2.3",
 * });
 * ```
 *
 * @resource
 */
export const ConnectedEnvironment = Resource<ConnectedEnvironment>(
  "Azure.ContainerApps.ConnectedEnvironment",
);

const createEnvironmentName = (id: string) => createContainerAppsName(id, 60);

const getEnvironment = (
  subscriptionId: string,
  resourceGroupName: string,
  connectedEnvironmentName: string,
) =>
  orUndefinedIfNotFound(
    app.GetConnectedEnvironment({
      subscriptionId,
      resourceGroupName,
      connectedEnvironmentName,
    }),
  );

const toAttrs = (
  resourceGroup: string,
  name: string,
  observed: app.GetConnectedEnvironmentResponse,
): ConnectedEnvironment["Attributes"] => ({
  environmentName: name,
  environmentId: observed.id ?? "",
  resourceGroup,
  location: observed.location,
  customLocationId: observed.extendedLocation?.name,
  defaultDomain: observed.properties?.defaultDomain,
  staticIp: observed.properties?.staticIp,
  tags: userTags(observed.tags),
});

const toProperties = (
  props: ConnectedEnvironmentProps,
): app.ConnectedEnvironmentPropertiesInput => ({
  staticIp: props.staticIp,
  daprAIConnectionString: reveal(props.daprAIConnectionString),
  customDomainConfiguration: props.customDomainConfiguration,
});

export const ConnectedEnvironmentProvider = () =>
  Provider.succeed(ConnectedEnvironment, {
    stables: ["environmentName", "environmentId", "resourceGroup", "location"],

    list: Effect.fn(function* () {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const page = yield* app
        .ListConnectedEnvironmentBySubscription({ subscriptionId })
        .pipe(
          Effect.flatMap((page) =>
            requireSinglePage("ListConnectedEnvironmentBySubscription", page),
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
        (news.name !== undefined && news.name !== output.environmentName) ||
        (news.location !== undefined &&
          !sameLocation(news.location, output.location)) ||
        lower(news.customLocationId) !== lower(output.customLocationId) ||
        (news.staticIp !== undefined && news.staticIp !== output.staticIp)
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
      const resourceGroup = news.resourceGroup;
      const name =
        news.name ??
        output?.environmentName ??
        (yield* createEnvironmentName(id));
      const location = news.location ?? output?.location ?? env.location;
      const tags = yield* desiredTags(id, news.tags);
      const properties = toProperties(news);
      const where = {
        subscriptionId,
        resourceGroupName: resourceGroup,
        connectedEnvironmentName: name,
      };
      const get = getEnvironment(subscriptionId, resourceGroup, name);
      const put = app.ConnectedEnvironmentsCreateOrUpdate({
        ...where,
        location,
        tags,
        extendedLocation: {
          name: news.customLocationId,
          type: "CustomLocation",
        },
        properties,
      });
      const ready = waitForProvisioned(
        `connected environment ${name}`,
        get,
        (environment) => environment.properties?.provisioningState,
        { interval: "10 seconds", times: 90 },
      );

      // Observe.
      let observed = yield* get;

      // Ensure.
      if (observed === undefined) {
        yield* put;
      }
      observed = yield* ready;

      // Sync properties (full PUT; secrets are compared against the
      // previous props), then tags (PATCH).
      const { daprAIConnectionString: _secret, ...echoed } = properties;
      if (
        !matchesDesired(
          { ...echoed, customDomainConfiguration: undefined },
          observed.properties,
        ) ||
        (olds !== undefined &&
          fingerprint(properties) !== fingerprint(toProperties(olds)))
      ) {
        yield* put;
        observed = yield* ready;
      }
      if (tagsDiffer(observed.tags, tags)) {
        yield* app.UpdateConnectedEnvironment({ ...where, tags });
        observed = yield* ready;
      }

      return toAttrs(resourceGroup, name, observed);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        app.DeleteConnectedEnvironment({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          connectedEnvironmentName: output.environmentName,
        }),
      );
      yield* waitUntilGone(
        `connected environment ${output.environmentName}`,
        getEnvironment(
          subscriptionId,
          output.resourceGroup,
          output.environmentName,
        ),
        { interval: "10 seconds", times: 90 },
      );
    }),

    nuke: { dependsOn: ["Azure.Resources.ResourceGroup"] },
  });
