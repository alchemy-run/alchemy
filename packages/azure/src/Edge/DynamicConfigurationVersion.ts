import * as edge from "@distilled.cloud/azure/edge";
import { isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import type { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import {
  ensureRegistered,
  ignoreNotFound,
  orUndefinedIfNotFound,
  waitForProvisioned,
  waitUntilGone,
} from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import { GroupedResource } from "../StackResourceGroup.ts";
import { EDGE_WAIT, edgeState, payloadText } from "./EdgeShared.ts";

export interface DynamicConfigurationVersionProps {
  /** Resource group of the configuration. Changing it replaces the version. */
  resourceGroup: string;
  /** Name of the configuration that holds the dynamic configuration. Changing it replaces the version. */
  configuration: string;
  /** Name of the parent dynamic configuration. Changing it replaces the version. */
  dynamicConfiguration: string;
  /**
   * Semantic version, e.g. `1.0.0`. It must name an existing version of
   * the config template (or solution template) the dynamic configuration
   * belongs to; otherwise Azure fails with `System generated Schema not
   * found`.
   *
   * :::caution
   * Changing the version creates a new version and deletes the old one.
   * :::
   */
  version: string;
  /** Configuration values as YAML (`Key: value` lines). Updated in place. */
  values: string;
}

export interface DynamicConfigurationVersion extends Resource<
  "Azure.Edge.DynamicConfigurationVersion",
  DynamicConfigurationVersionProps,
  {
    /** Version name. */
    version: string;
    /** Name of the configuration that holds the dynamic configuration. */
    configuration: string;
    /** Name of the parent dynamic configuration. */
    dynamicConfiguration: string;
    /** Resource group of the configuration. */
    resourceGroup: string;
    /** ARM resource ID of the version. */
    dynamicConfigurationVersionId: string;
    /** Configuration values YAML. */
    values: string;
  },
  never,
  Providers
> {}

/**
 * A version of an Azure Arc workload orchestration dynamic configuration
 * (`Microsoft.Edge/configurations/dynamicConfigurations/versions`): the
 * YAML configuration values a hierarchy entity sets for one version of a
 * solution or config template.
 *
 * Versions carry no tags or free-form fields, so Alchemy cannot mark them;
 * a version found under the expected name is treated as this resource.
 *
 * @see https://learn.microsoft.com/azure/azure-arc/workload-orchestration/configuration-model
 *
 * ### Publishing Values
 * **Example:** Configuration values for a template
 * ```typescript
 * yield* Azure.Edge.DynamicConfigurationVersion("app-values-v1", {
 *   configuration: configuration.configurationName,
 *   dynamicConfiguration: dynamic.dynamicConfigurationName,
 *   version: "1.0.0",
 *   values: "Greeting: hello\n",
 * });
 * ```
 *
 * @resource
 */
export const DynamicConfigurationVersion = GroupedResource<DynamicConfigurationVersion>(
  "Azure.Edge.DynamicConfigurationVersion",
);

interface Where {
  readonly resourceGroup: string;
  readonly configuration: string;
  readonly dynamicConfiguration: string;
  readonly version: string;
}

const request = (subscriptionId: string, where: Where) => ({
  subscriptionId,
  resourceGroupName: where.resourceGroup,
  configurationName: where.configuration,
  dynamicConfigurationName: where.dynamicConfiguration,
  dynamicConfigurationVersionName: where.version,
});

const getVersion = (subscriptionId: string, where: Where) =>
  orUndefinedIfNotFound(edge.GetDynamicConfigurationVersion(request(subscriptionId, where)));

const toAttrs = (
  where: Where,
  observed: edge.GetDynamicConfigurationVersionResponse,
): DynamicConfigurationVersion["Attributes"] => ({
  version: where.version,
  configuration: where.configuration,
  dynamicConfiguration: where.dynamicConfiguration,
  resourceGroup: where.resourceGroup,
  dynamicConfigurationVersionId: observed.id ?? "",
  values: payloadText(observed.properties?.values),
});

const label = (where: Where) =>
  `edge dynamic configuration version ${where.configuration}/${where.dynamicConfiguration}/${where.version}`;

export const DynamicConfigurationVersionProvider = () =>
  Provider.succeed(DynamicConfigurationVersion, {
    stables: [
      "version",
      "configuration",
      "dynamicConfiguration",
      "resourceGroup",
      "dynamicConfigurationVersionId",
    ],

    // Versions vanish with their configuration.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      const moved =
        news.resourceGroup.toLowerCase() !== output.resourceGroup.toLowerCase() ||
        news.configuration.toLowerCase() !== output.configuration.toLowerCase() ||
        news.dynamicConfiguration.toLowerCase() !== output.dynamicConfiguration.toLowerCase() ||
        news.version !== output.version;
      if (moved) return { action: "replace" } as const;
      return undefined;
    }),

    read: Effect.fn(function* ({ olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const source = output ?? olds;
      if (
        source?.resourceGroup === undefined ||
        source.configuration === undefined ||
        source.dynamicConfiguration === undefined ||
        source.version === undefined
      ) {
        return undefined;
      }
      const where = {
        resourceGroup: source.resourceGroup,
        configuration: source.configuration,
        dynamicConfiguration: source.dynamicConfiguration,
        version: source.version,
      };
      const observed = yield* getVersion(subscriptionId, where);
      return observed === undefined ? undefined : toAttrs(where, observed);
    }),

    reconcile: Effect.fn(function* ({ news }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, "Microsoft.Edge");
      const get = getVersion(subscriptionId, news);

      // Observe.
      const observed = yield* get;

      // Ensure and sync: the PUT is an upsert and the values are the
      // version's only mutable aspect.
      if (observed === undefined || observed.properties?.values !== news.values) {
        yield* edge.DynamicConfigurationVersionsCreateOrUpdate({
          ...request(subscriptionId, news),
          properties: { values: news.values },
        });
      }

      const fresh = yield* waitForProvisioned(label(news), get, edgeState, EDGE_WAIT);
      return toAttrs(news, fresh);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        edge.DeleteDynamicConfigurationVersion(request(subscriptionId, output)),
      );
      yield* waitUntilGone(label(output), getVersion(subscriptionId, output), EDGE_WAIT);
    }),
  });
