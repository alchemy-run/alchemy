import * as monitoringservice from "@distilled.cloud/azure/monitoringservice";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { tagRecord } from "../../Tags.ts";
import {
  ensureRegistered,
  ignoreNotFound,
  orUndefinedIfNotFound,
  stackAndStage,
  waitForProvisioned,
} from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";

/** Metrics Query Service version used for a workspace's metric queries. */
export type MetricsContainerVersion = "1.0" | "2.0";

/** The only metrics container an Azure Monitor workspace has. */
const CONTAINER_NAME = "default";

/** Version Azure assigns to a new workspace's metrics container. */
const DEFAULT_VERSION: MetricsContainerVersion = "2.0";

export interface MetricsContainerProps {
  /**
   * Resource group of the Azure Monitor workspace. Changing it replaces
   * the resource.
   */
  resourceGroup: string;
  /**
   * Name of the Azure Monitor workspace (`Azure.Monitor.Workspace`
   * `workspaceName`). Changing it replaces the resource.
   */
  workspaceName: string;
  /**
   * Version of the Metrics Query Service the workspace uses for all metric
   * queries.
   * @default "2.0"
   */
  version?: MetricsContainerVersion;
}

export interface MetricsContainer extends Resource<
  "Azure.Monitor.MetricsContainer",
  MetricsContainerProps,
  {
    /** ARM resource ID of the metrics container. */
    metricsContainerId: string;
    /** Resource group of the workspace. */
    resourceGroup: string;
    /** Name of the workspace. */
    workspaceName: string;
    /** Name of the metrics container (always `default`). */
    metricsContainerName: string;
    /** Metrics Query Service version in effect. */
    version: string | undefined;
  },
  never,
  Providers
> {}

/**
 * The metrics container settings of an Azure Monitor workspace — selects
 * the Metrics Query Service version used for all metric queries against
 * the workspace.
 *
 * Every workspace has exactly one container, `default`, created with the
 * workspace (version `2.0`). This resource manages its settings; destroying
 * it restores version `2.0` (there is no delete API — the container goes
 * away with its workspace). It has no tags: ownership follows the
 * workspace's Alchemy tags.
 *
 * @see https://learn.microsoft.com/rest/api/monitor/metrics-containers
 *
 * ### Configuring the Query Version
 * **Example:** Pin a workspace to Metrics Query Service 1.0
 * ```typescript
 * const metrics = yield* Azure.Monitor.Workspace("metrics", {
 *   resourceGroup: group.resourceGroupName,
 * });
 * yield* Azure.Monitor.MetricsContainer("metrics-container", {
 *   resourceGroup: metrics.resourceGroup,
 *   workspaceName: metrics.workspaceName,
 *   version: "1.0",
 * });
 * ```
 *
 * @resource
 */
export const MetricsContainer = Resource<MetricsContainer>(
  "Azure.Monitor.MetricsContainer",
);

const sameText = (a: string | undefined, b: string | undefined) =>
  (a ?? "").toLowerCase() === (b ?? "").toLowerCase();

/**
 * Right after a workspace is created its metrics container answers 500
 * (`MetricsContainerNotReady`) until the backing metrics account is wired
 * up; retry through that window.
 */
const untilReady = <A, E extends { readonly _tag: string }, R>(
  effect: Effect.Effect<A, E, R>,
) =>
  effect.pipe(
    Effect.retry({
      while: (e) => e._tag === "MetricsContainerNotReady",
      schedule: Schedule.spaced("5 seconds"),
      times: 36,
    }),
  );

const getContainer = (
  subscriptionId: string,
  resourceGroupName: string,
  azureMonitorWorkspaceName: string,
) =>
  untilReady(
    orUndefinedIfNotFound(
      monitoringservice.GetMetricsContainer({
        subscriptionId,
        resourceGroupName,
        azureMonitorWorkspaceName,
        metricsContainerName: CONTAINER_NAME,
      }),
    ),
  );

const putVersion = (
  subscriptionId: string,
  resourceGroupName: string,
  azureMonitorWorkspaceName: string,
  version: MetricsContainerVersion,
) =>
  untilReady(
    monitoringservice.MetricsContainersCreateOrUpdate({
      subscriptionId,
      resourceGroupName,
      azureMonitorWorkspaceName,
      metricsContainerName: CONTAINER_NAME,
      properties: { version },
    }),
  );

/** Whether the parent workspace carries this stack/stage's Alchemy tags. */
const isWorkspaceOwnedByStack = Effect.fn(function* (
  subscriptionId: string,
  resourceGroupName: string,
  azureMonitorWorkspaceName: string,
) {
  const workspace = yield* orUndefinedIfNotFound(
    monitoringservice.GetAzureMonitorWorkspace({
      subscriptionId,
      resourceGroupName,
      azureMonitorWorkspaceName,
    }),
  );
  if (workspace === undefined) return false;
  const { stack, stage } = yield* stackAndStage;
  const tags = tagRecord(workspace.tags);
  return tags["alchemy::stack"] === stack && tags["alchemy::stage"] === stage;
});

const toAttrs = (
  resourceGroup: string,
  workspaceName: string,
  container: monitoringservice.GetMetricsContainerResponse,
): MetricsContainer["Attributes"] => ({
  metricsContainerId: container.id ?? "",
  resourceGroup,
  workspaceName,
  metricsContainerName: container.name ?? CONTAINER_NAME,
  version: container.properties?.version,
});

export const MetricsContainerProvider = () =>
  Provider.succeed(MetricsContainer, {
    stables: [
      "metricsContainerId",
      "resourceGroup",
      "workspaceName",
      "metricsContainerName",
    ],

    // The list API answers 404 and the container vanishes with its
    // workspace, so there is nothing to enumerate for cleanup.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        !sameText(news.resourceGroup, output.resourceGroup) ||
        !sameText(news.workspaceName, output.workspaceName)
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      const workspaceName = output?.workspaceName ?? olds?.workspaceName;
      if (resourceGroup === undefined || workspaceName === undefined) {
        return undefined;
      }
      const observed = yield* getContainer(
        subscriptionId,
        resourceGroup,
        workspaceName,
      );
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, workspaceName, observed);
      return (yield* isWorkspaceOwnedByStack(
        subscriptionId,
        resourceGroup,
        workspaceName,
      ))
        ? attrs
        : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ news }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, "Microsoft.Monitor");
      const { resourceGroup, workspaceName } = news;
      const version = news.version ?? DEFAULT_VERSION;
      const get = getContainer(subscriptionId, resourceGroup, workspaceName);

      // Observe; the container always exists once the workspace does, so
      // a single PUT both ensures and syncs the version.
      const observed = yield* get;
      if (observed?.properties?.version !== version) {
        yield* putVersion(
          subscriptionId,
          resourceGroup,
          workspaceName,
          version,
        );
      }

      const final = yield* waitForProvisioned(
        `Azure Monitor metrics container ${workspaceName}/${CONTAINER_NAME}`,
        get,
        (container) => container.properties?.provisioningState,
        { interval: "3 seconds", times: 40 },
      );
      return toAttrs(resourceGroup, workspaceName, final);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      // No delete API: restore the service default while the workspace
      // still exists; a missing workspace means the container is gone.
      const observed = yield* getContainer(
        subscriptionId,
        output.resourceGroup,
        output.workspaceName,
      );
      if (
        observed !== undefined &&
        observed.properties?.version !== DEFAULT_VERSION
      ) {
        yield* ignoreNotFound(
          putVersion(
            subscriptionId,
            output.resourceGroup,
            output.workspaceName,
            DEFAULT_VERSION,
          ),
        );
      }
    }),

    nuke: {
      dependsOn: ["Azure.Resources.ResourceGroup", "Azure.Monitor.Workspace"],
    },
  });
