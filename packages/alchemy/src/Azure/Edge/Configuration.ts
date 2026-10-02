import * as edge from "@distilled.cloud/azure/edge";
import * as Effect from "effect/Effect";
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
import { EDGE_WAIT, edgeState } from "./EdgeShared.ts";

export interface ConfigurationProps {
  /** Resource group the configuration is created in. Changing it replaces the configuration. */
  resourceGroup: string;
  /**
   * Name of the configuration. If omitted, a unique name is generated from the
   * app, stage, and logical ID. Changing it replaces the configuration.
   */
  name?: string;
  /**
   * Azure location of the configuration. Workload orchestration is
   * available in `eastus` and `eastus2`. Changing it replaces the configuration.
   * @default the `Azure.Location` layer, else the profile location, else `eastus`
   */
  location?: string;
  /**
   * User tags. Alchemy ownership tags (`alchemy::stack`, `alchemy::stage`,
   * `alchemy::id`) are merged in automatically.
   */
  tags?: Record<string, string>;
}

export interface Configuration extends Resource<
  "Azure.Edge.Configuration",
  ConfigurationProps,
  {
    /** Name of the configuration. */
    configurationName: string;
    /** Resource group that holds the configuration. */
    resourceGroup: string;
    /** ARM resource ID of the configuration. */
    configurationId: string;
    /** Location of the configuration. */
    location: string;
    /** User tags (Alchemy ownership tags stripped). */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * An Azure Arc workload orchestration configuration. Configurations hold
 * the configuration values of a hierarchy entity (a site or target); they
 * are linked to it with an `Azure.Edge.ConfigurationReference`.
 *
 * @see https://learn.microsoft.com/azure/azure-arc/workload-orchestration/configuration-model
 *
 * ### Creating a Configuration
 * **Example:** Configuration referenced by a site
 * ```typescript
 * const group = yield* Azure.Resources.ResourceGroup("edge", {
 *   location: "eastus",
 * });
 * const site = yield* Azure.Edge.Site("plant", {
 *   resourceGroup: group.resourceGroupName,
 * });
 * const configuration = yield* Azure.Edge.Configuration("plant-config", {
 *   resourceGroup: group.resourceGroupName,
 * });
 * yield* Azure.Edge.ConfigurationReference("plant-config-ref", {
 *   resourceUri: site.siteId,
 *   configurationResourceId: configuration.configurationId,
 * });
 * ```
 *
 * @resource
 */
export const Configuration = Resource<Configuration>("Azure.Edge.Configuration");

const getConfiguration = (
  subscriptionId: string,
  resourceGroupName: string,
  configurationName: string,
) =>
  orUndefinedIfNotFound(
    edge.GetConfiguration({ subscriptionId, resourceGroupName, configurationName }),
  );

const toAttrs = (
  resourceGroup: string,
  name: string,
  configuration: edge.GetConfigurationResponse,
): Configuration["Attributes"] => ({
  configurationName: name,
  resourceGroup,
  configurationId: configuration.id ?? "",
  location: configuration.location,
  tags: userTags(configuration.tags),
});

const configurationName = (id: string) => createPhysicalName({ id, maxLength: 63 });

export const ConfigurationProvider = () =>
  Provider.succeed(Configuration, {
    stables: ["configurationName", "resourceGroup", "configurationId", "location"],

    list: Effect.fn(function* () {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const page = yield* edge
        .ListConfigurationBySubscription({ subscriptionId })
        .pipe(
          Effect.flatMap((page) =>
            requireSinglePage("ListConfigurationBySubscription", page),
          ),
        );
      return page.value.flatMap((configuration) => {
        const group = resourceGroupOf(configuration.id);
        return hasAnyAlchemyTag(configuration.tags) &&
          group !== undefined &&
          configuration.name !== undefined
          ? [toAttrs(group, configuration.name, configuration)]
          : [];
      });
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        news.resourceGroup.toLowerCase() !==
          output.resourceGroup.toLowerCase() ||
        (news.name !== undefined &&
          news.name.toLowerCase() !== output.configurationName.toLowerCase()) ||
        (news.location !== undefined &&
          news.location.toLowerCase() !== output.location.toLowerCase())
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      if (resourceGroup === undefined) return undefined;
      const name = output?.configurationName ?? olds?.name ?? (yield* configurationName(id));
      const observed = yield* getConfiguration(subscriptionId, resourceGroup, name);
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, name, observed);
      return (yield* isOwned(id, observed.tags)) ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* AzureEnvironment.current;
      const { subscriptionId } = env;
      yield* ensureRegistered(subscriptionId, "Microsoft.Edge");
      const resourceGroup = news.resourceGroup;
      const name = news.name ?? output?.configurationName ?? (yield* configurationName(id));
      const tags = yield* desiredTags(id, news.tags);
      const get = getConfiguration(subscriptionId, resourceGroup, name);

      // Observe.
      const observed = yield* get;

      // Ensure, then sync tags (the configuration's only mutable aspect).
      if (observed === undefined) {
        yield* edge.ConfigurationsCreateOrUpdate({
          subscriptionId,
          resourceGroupName: resourceGroup,
          configurationName: name,
          location: news.location ?? output?.location ?? env.location,
          tags,
          properties: {},
        });
      } else if (tagsDiffer(observed.tags, tags)) {
        yield* edge.UpdateConfiguration({
          subscriptionId,
          resourceGroupName: resourceGroup,
          configurationName: name,
          tags,
        });
      }

      const fresh = yield* waitForProvisioned(
        `edge configuration ${name}`,
        get,
        edgeState,
        EDGE_WAIT,
      );
      return toAttrs(resourceGroup, name, fresh);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        edge.DeleteConfiguration({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          configurationName: output.configurationName,
        }),
      );
      yield* waitUntilGone(
        `edge configuration ${output.configurationName}`,
        getConfiguration(subscriptionId, output.resourceGroup, output.configurationName),
        EDGE_WAIT,
      );
    }),

    nuke: { dependsOn: ["Azure.Resources.ResourceGroup"] },
  });
