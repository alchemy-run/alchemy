import * as postgresqlhsc from "@distilled.cloud/azure/postgresqlhsc";
import * as Effect from "effect/Effect";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import {
  ensureRegistered,
  NOT_FOUND_TAGS,
  orUndefinedIfNotFound,
  waitForProvisioned,
} from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import {
  type ClusterRef,
  COSMOS_POSTGRES_NAMESPACE,
  sameText,
  whileClusterBusy,
} from "./common.ts";

export interface CoordinatorConfigurationProps {
  /** Resource group of the cluster. Changing it replaces the configuration. */
  resourceGroup: string;
  /** Name of the cluster. Changing it replaces the configuration. */
  cluster: string;
  /**
   * Server parameter name, e.g. `log_min_duration_statement`. Changing it
   * replaces the configuration.
   */
  name: string;
  /** Value to assign to the parameter on the coordinator. */
  value: string;
}

export interface CoordinatorConfiguration extends Resource<
  "Azure.CosmosDBPostgreSQL.CoordinatorConfiguration",
  CoordinatorConfigurationProps,
  {
    /** Parameter name. */
    configurationName: string;
    /** ARM resource ID of the parameter. */
    configurationId: string;
    /** Name of the cluster. */
    cluster: string;
    /** Resource group of the cluster. */
    resourceGroup: string;
    /** Current value. */
    value: string | undefined;
    /** Azure's default value, written back when the resource is deleted. */
    defaultValue: string | undefined;
    /** Data type (`Boolean`, `Numeric`, `Integer`, `Enumeration`). */
    dataType: string | undefined;
    /** Allowed values, e.g. a range or a comma-separated list. */
    allowedValues: string | undefined;
    /** Whether a change takes effect only after a cluster restart. */
    requiresRestart: boolean;
    /** Source of the value (`user-override`, `system-default`). */
    source: string | undefined;
  },
  never,
  Providers
> {}

/**
 * A server parameter on the coordinator of an Azure Cosmos DB for
 * PostgreSQL cluster.
 *
 * Every parameter always exists; this resource overrides its value and
 * restores Azure's default when deleted. Parameters with
 * `requiresRestart` apply after the next cluster restart.
 *
 * @see https://learn.microsoft.com/azure/cosmos-db/postgresql/reference-parameters
 *
 * ### Setting Parameters
 * **Example:** Log slow statements on the coordinator
 * ```typescript
 * const slowLog = yield* Azure.CosmosDBPostgreSQL.CoordinatorConfiguration(
 *   "slow-log",
 *   {
 *     resourceGroup: group.resourceGroupName,
 *     cluster: cluster.clusterName,
 *     name: "log_min_duration_statement",
 *     value: "500",
 *   },
 * );
 * ```
 *
 * @resource
 */
export const CoordinatorConfiguration = Resource<CoordinatorConfiguration>(
  "Azure.CosmosDBPostgreSQL.CoordinatorConfiguration",
);

interface ConfigurationRef extends ClusterRef {
  readonly configurationName: string;
}

const getConfiguration = (ref: ConfigurationRef) =>
  orUndefinedIfNotFound(postgresqlhsc.GetConfigurationCoordinator(ref));

const toAttrs = (
  ref: ConfigurationRef,
  config: postgresqlhsc.GetConfigurationCoordinatorResponse,
): CoordinatorConfiguration["Attributes"] => ({
  configurationName: ref.configurationName,
  configurationId: config.id ?? "",
  cluster: ref.clusterName,
  resourceGroup: ref.resourceGroupName,
  value: config.properties?.value,
  defaultValue: config.properties?.defaultValue,
  dataType: config.properties?.dataType,
  allowedValues: config.properties?.allowedValues,
  requiresRestart: config.properties?.requiresRestart ?? false,
  source: config.properties?.source,
});

/** Put a parameter value and wait until the coordinator reports it. */
const putValue = (ref: ConfigurationRef, value: string) =>
  Effect.gen(function* () {
    yield* postgresqlhsc
      .UpdateConfigurationOnCoordinator({ ...ref, properties: { value } })
      .pipe(Effect.retry(whileClusterBusy));
    return yield* waitForProvisioned(
      `Cosmos DB for PostgreSQL coordinator configuration ${ref.configurationName}`,
      getConfiguration(ref),
      (config) =>
        sameText(config.properties?.value, value)
          ? (config.properties?.provisioningState ?? "Succeeded")
          : "Updating",
      { interval: "5 seconds", times: 60 },
    );
  });

export const CoordinatorConfigurationProvider = () =>
  Provider.succeed(CoordinatorConfiguration, {
    stables: [
      "configurationName",
      "configurationId",
      "cluster",
      "resourceGroup",
    ],

    // Parameters are cluster singletons; nothing to enumerate for nuke.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        !sameText(news.resourceGroup, output.resourceGroup) ||
        !sameText(news.cluster, output.cluster) ||
        news.name !== output.configurationName
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    // Every parameter always exists, so it is adopted implicitly.
    read: Effect.fn(function* ({ olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroupName = output?.resourceGroup ?? olds?.resourceGroup;
      const clusterName = output?.cluster ?? olds?.cluster;
      const configurationName = output?.configurationName ?? olds?.name;
      if (
        resourceGroupName === undefined ||
        clusterName === undefined ||
        configurationName === undefined
      ) {
        return undefined;
      }
      const ref = {
        subscriptionId,
        resourceGroupName,
        clusterName,
        configurationName,
      };
      const observed = yield* getConfiguration(ref);
      return observed === undefined ? undefined : toAttrs(ref, observed);
    }),

    reconcile: Effect.fn(function* ({ news }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, COSMOS_POSTGRES_NAMESPACE);
      const ref: ConfigurationRef = {
        subscriptionId,
        resourceGroupName: news.resourceGroup,
        clusterName: news.cluster,
        configurationName: news.name,
      };

      // Observe, then sync the value against the observed one.
      let observed = yield* postgresqlhsc.GetConfigurationCoordinator(ref);
      if (!sameText(observed.properties?.value, news.value)) {
        observed = yield* putValue(ref, news.value);
      }
      return toAttrs(ref, observed);
    }),

    // Restore Azure's default; a missing cluster means nothing to reset.
    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const ref: ConfigurationRef = {
        subscriptionId,
        resourceGroupName: output.resourceGroup,
        clusterName: output.cluster,
        configurationName: output.configurationName,
      };
      const observed = yield* getConfiguration(ref);
      const defaultValue = observed?.properties?.defaultValue;
      if (
        observed === undefined ||
        defaultValue === undefined ||
        sameText(observed.properties?.value, defaultValue)
      ) {
        return;
      }
      yield* putValue(ref, defaultValue).pipe(
        Effect.catchTag([...NOT_FOUND_TAGS], () => Effect.void),
      );
    }),

    nuke: { singleton: true },
  });
