import * as edge from "@distilled.cloud/azure/edge";
import * as Effect from "effect/Effect";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import {
  ensureRegistered,
  ignoreNotFound,
  orUndefinedIfNotFound,
  waitForProvisioned,
  waitUntilGone,
} from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import { EDGE_WAIT, edgeState } from "./EdgeShared.ts";

export interface DynamicConfigurationProps {
  /** Resource group of the configuration. Changing it replaces the dynamic configuration. */
  resourceGroup: string;
  /** Name of the parent configuration. Changing it replaces the dynamic configuration. */
  configuration: string;
  /**
   * Name of the dynamic configuration: the name or unique identifier of
   * the solution or config template it configures. Changing it replaces
   * the dynamic configuration.
   */
  name: string;
  /** Version of the values that is current, e.g. `1.0.0`. */
  currentVersion: string;
}

export interface DynamicConfiguration extends Resource<
  "Azure.Edge.DynamicConfiguration",
  DynamicConfigurationProps,
  {
    /** Name of the dynamic configuration. */
    dynamicConfigurationName: string;
    /** Name of the parent configuration. */
    configuration: string;
    /** Resource group of the configuration. */
    resourceGroup: string;
    /** ARM resource ID of the dynamic configuration. */
    dynamicConfigurationId: string;
    /** Version of the values that is current. */
    currentVersion: string;
    /** Configuration type reported by the service. */
    configurationType: string | undefined;
    /** Configuration model reported by the service. */
    configurationModel: string | undefined;
  },
  never,
  Providers
> {}

/**
 * A dynamic configuration under an Azure Arc workload orchestration
 * configuration. It tracks which version of a solution or config
 * template's values is current; the values live in immutable
 * `Azure.Edge.DynamicConfigurationVersion` children. Its name must be the
 * name (or unique identifier) of the solution or config template it
 * configures.
 *
 * Dynamic configurations carry no tags or free-form fields, so Alchemy
 * cannot mark them; one found under the expected name is treated as this
 * resource.
 *
 * @see https://learn.microsoft.com/azure/azure-arc/workload-orchestration/configuration-model
 *
 * ### Creating a Dynamic Configuration
 * **Example:** Values for a solution template
 * ```typescript
 * const dynamic = yield* Azure.Edge.DynamicConfiguration("app-values", {
 *   resourceGroup: group.resourceGroupName,
 *   configuration: configuration.configurationName,
 *   name: app.solutionTemplateName,
 *   currentVersion: "1.0.0",
 * });
 * ```
 *
 * @resource
 */
export const DynamicConfiguration = Resource<DynamicConfiguration>(
  "Azure.Edge.DynamicConfiguration",
);

const getDynamicConfiguration = (
  subscriptionId: string,
  resourceGroupName: string,
  configurationName: string,
  dynamicConfigurationName: string,
) =>
  orUndefinedIfNotFound(
    edge.GetDynamicConfiguration({
      subscriptionId,
      resourceGroupName,
      configurationName,
      dynamicConfigurationName,
    }),
  );

const toAttrs = (
  resourceGroup: string,
  configuration: string,
  name: string,
  observed: edge.GetDynamicConfigurationResponse,
): DynamicConfiguration["Attributes"] => ({
  dynamicConfigurationName: name,
  configuration,
  resourceGroup,
  dynamicConfigurationId: observed.id ?? "",
  currentVersion: observed.properties?.currentVersion ?? "",
  configurationType: observed.properties?.dynamicConfigurationType,
  configurationModel: observed.properties?.dynamicConfigurationModel,
});

export const DynamicConfigurationProvider = () =>
  Provider.succeed(DynamicConfiguration, {
    stables: [
      "dynamicConfigurationName",
      "configuration",
      "resourceGroup",
      "dynamicConfigurationId",
    ],

    // Dynamic configurations vanish with their configuration.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        news.resourceGroup.toLowerCase() !==
          output.resourceGroup.toLowerCase() ||
        news.configuration.toLowerCase() !==
          output.configuration.toLowerCase() ||
        news.name.toLowerCase() !==
          output.dynamicConfigurationName.toLowerCase()
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      const configuration = output?.configuration ?? olds?.configuration;
      if (resourceGroup === undefined || configuration === undefined)
        return undefined;
      const name = output?.dynamicConfigurationName ?? olds?.name;
      if (name === undefined) return undefined;
      const observed = yield* getDynamicConfiguration(
        subscriptionId,
        resourceGroup,
        configuration,
        name,
      );
      return observed === undefined
        ? undefined
        : toAttrs(resourceGroup, configuration, name, observed);
    }),

    reconcile: Effect.fn(function* ({ news }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, "Microsoft.Edge");
      const { resourceGroup, configuration } = news;
      const name = news.name;
      const get = getDynamicConfiguration(
        subscriptionId,
        resourceGroup,
        configuration,
        name,
      );

      // Observe.
      const observed = yield* get;

      // Ensure, then sync the current version against observed state.
      if (observed === undefined) {
        yield* edge.DynamicConfigurationsCreateOrUpdate({
          subscriptionId,
          resourceGroupName: resourceGroup,
          configurationName: configuration,
          dynamicConfigurationName: name,
          properties: { currentVersion: news.currentVersion },
        });
      } else if (observed.properties?.currentVersion !== news.currentVersion) {
        yield* edge.UpdateDynamicConfiguration({
          subscriptionId,
          resourceGroupName: resourceGroup,
          configurationName: configuration,
          dynamicConfigurationName: name,
          properties: { currentVersion: news.currentVersion },
        });
      }

      const fresh = yield* waitForProvisioned(
        `edge dynamic configuration ${configuration}/${name}`,
        get,
        edgeState,
        EDGE_WAIT,
      );
      return toAttrs(resourceGroup, configuration, name, fresh);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        edge.DeleteDynamicConfiguration({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          configurationName: output.configuration,
          dynamicConfigurationName: output.dynamicConfigurationName,
        }),
      );
      yield* waitUntilGone(
        `edge dynamic configuration ${output.configuration}/${output.dynamicConfigurationName}`,
        getDynamicConfiguration(
          subscriptionId,
          output.resourceGroup,
          output.configuration,
          output.dynamicConfigurationName,
        ),
        EDGE_WAIT,
      );
    }),
  });
