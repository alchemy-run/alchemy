import * as monitoringservice from "@distilled.cloud/azure/monitoringservice";
import { Unowned } from "alchemy/AdoptPolicy";
import { isResolved } from "alchemy/Diff";
import { createPhysicalName } from "alchemy/PhysicalName";
import * as Provider from "alchemy/Provider";
import type { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import {
  collectAll,
  desiredTags,
  ensureRegistered,
  hasAnyAlchemyTag,
  ignoreNotFound,
  isOwned,
  orUndefinedIfNotFound,
  resourceGroupOf,
  tagsDiffer,
  userTags,
  waitForProvisioned,
  waitUntilGone,
} from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import { GroupedResource } from "../StackResourceGroup.ts";

/** A pipeline group receiver (Syslog or OTLP listener). */
export type PipelineGroupReceiver = monitoringservice.Receiver;
/** A pipeline group processor (batch or KQL transform). */
export type PipelineGroupProcessor = monitoringservice.Processor;
/** A pipeline group exporter (Azure Monitor workspace logs). */
export type PipelineGroupExporter = monitoringservice.Exporter;
/** The pipelines wiring receivers, processors, and exporters together. */
export type PipelineGroupService = monitoringservice.Service;
/** Placement constraints for the pipeline group's instances. */
export type PipelineGroupExecutionPlacement = monitoringservice.ExecutionPlacement;
/** A named TLS configuration referenced by receivers. */
export type PipelineGroupTlsConfiguration = monitoringservice.TlsConfiguration;

export interface PipelineGroupProps {
  /**
   * Resource group the pipeline group is created in.
   *
   * :::caution
   * Changing it replaces the pipeline group.
   * :::
   * @default the stack's resource group (`Azure.resourceGroup(...)`, else `<stack>-<stage>`)
   */
  resourceGroup: string;
  /**
   * Pipeline group name: up to 63 lowercase letters, digits, and hyphens.
   *
   * :::caution
   * Changing it replaces the pipeline group.
   * :::
   * @default a name generated from the app, stage, and logical ID
   */
  name?: string;
  /**
   * Azure location of the pipeline group (the custom location's region).
   *
   * :::caution
   * Changing it replaces the pipeline group.
   * :::
   * @default the `Azure.Location` layer, else the profile location, else `eastus`
   */
  location?: string;
  /**
   * ARM resource ID of the Azure Arc custom location
   * (`Microsoft.ExtendedLocation/customLocations`) on the Arc-enabled
   * Kubernetes cluster that runs the pipeline, e.g.
   * `customLocation.customLocationId` of an
   * `Azure.ExtendedLocation.CustomLocation`.
   *
   * :::caution
   * Changing it replaces the pipeline group.
   * :::
   */
  customLocationId: string;
  /**
   * Number of replicas of the pipeline group instance on the cluster.
   * @default Azure's default
   */
  replicas?: number;
  /**
   * Receivers of the pipeline group: `Syslog` (`syslog: { endpoint }`) or
   * `OTLP` (`otlp: { endpoint }`) listeners, each with a unique `name`.
   * Endpoints are `host:port`, e.g. `0.0.0.0:514`.
   */
  receivers: PipelineGroupReceiver[];
  /**
   * Processors of the pipeline group: `Batch`, `TransformLanguage` (KQL),
   * `MicrosoftSyslog`, or `MicrosoftCommonSecurityLog`.
   * @default []
   */
  processors?: PipelineGroupProcessor[];
  /**
   * Exporters sending data to Azure Monitor: `AzureMonitorWorkspaceLogs`
   * with a data collection endpoint URL, a data collection rule immutable
   * ID, a stream, and a record mapping.
   */
  exporters: PipelineGroupExporter[];
  /**
   * Pipelines connecting receivers, processors, and exporters by `name`.
   */
  service: PipelineGroupService;
  /**
   * Placement constraints for the pipeline group's instances on the
   * cluster's nodes.
   * @default no constraints
   */
  executionPlacement?: PipelineGroupExecutionPlacement;
  /**
   * Named TLS configurations that receivers reference by name.
   * @default none (receivers use the default TLS configuration)
   */
  tlsConfigurations?: PipelineGroupTlsConfiguration[];
  /**
   * User tags. Alchemy ownership tags (`alchemy::stack`, `alchemy::stage`,
   * `alchemy::id`) are merged in automatically.
   * @default {}
   */
  tags?: Record<string, string>;
}

export interface PipelineGroup extends Resource<
  "Azure.Monitor.PipelineGroup",
  PipelineGroupProps,
  {
    /** Name of the pipeline group. */
    pipelineGroupName: string;
    /** Resource group that holds the pipeline group. */
    resourceGroup: string;
    /** ARM resource ID of the pipeline group. */
    pipelineGroupId: string;
    /** Location of the pipeline group. */
    location: string;
    /** ARM resource ID of the custom location the pipeline runs on. */
    customLocationId: string;
    /** Provisioning state reported by Azure. */
    provisioningState: string | undefined;
    /** User tags (Alchemy ownership tags stripped). */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * An Azure Monitor pipeline group (`Microsoft.Monitor/pipelineGroups`): an
 * Azure Monitor pipeline at the edge. It receives Syslog or OTLP telemetry
 * on an Arc-enabled Kubernetes cluster, can batch or transform it, and
 * forwards it to Azure Monitor through a data collection rule. Use it to
 * collect telemetry from devices on a local network.
 *
 * :::caution[Changing `name`, `location`, `customLocationId`, or `resourceGroup` replaces the pipeline group]
 * Alchemy creates a new pipeline group and deletes the old one.
 * :::
 *
 * :::caution[It needs an Arc-enabled Kubernetes cluster with a custom location]
 * Connect a Kubernetes cluster to Azure Arc, install the Azure Monitor
 * pipeline extension on it, and create a custom location on it
 * (`Azure.ExtendedLocation.CustomLocation`). Create the pipeline group in
 * the custom location's region.
 * :::
 *
 * :::caution[The exporter needs a data collection endpoint and rule]
 * Alchemy has no data collection rule resource yet. Create the data
 * collection endpoint and rule (with the exporter's stream) outside
 * Alchemy, or in an `Azure.Resources.DeploymentStack`, and pass the
 * endpoint URL and the rule's immutable ID.
 * :::
 *
 * @see https://learn.microsoft.com/azure/azure-monitor/essentials/edge-pipeline-configure
 *
 * ### Creating a Pipeline Group
 * **Example:** Syslog to a Log Analytics table through a DCR
 * ```typescript
 * // created outside Alchemy
 * const customLocationId =
 *   "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/edge/providers/Microsoft.ExtendedLocation/customLocations/factory";
 * const dceUrl = "https://edge-dce-abcd.eastus-1.ingest.monitor.azure.com";
 * const dcrImmutableId = "dcr-00000000000000000000000000000000";
 *
 * const pipeline = yield* Azure.Monitor.PipelineGroup("edge", {
 *   location: "eastus",
 *   customLocationId,
 *   receivers: [
 *     { type: "Syslog", name: "syslog", syslog: { endpoint: "0.0.0.0:514" } },
 *   ],
 *   exporters: [
 *     {
 *       type: "AzureMonitorWorkspaceLogs",
 *       name: "logs",
 *       azureMonitorWorkspaceLogs: {
 *         api: {
 *           dataCollectionEndpointUrl: dceUrl,
 *           dataCollectionRule: dcrImmutableId,
 *           stream: "Custom-Syslog",
 *           schema: { recordMap: [{ from: "body", to: "Body" }] },
 *         },
 *       },
 *     },
 *   ],
 *   service: {
 *     pipelines: [
 *       { name: "syslog", type: "Logs", receivers: ["syslog"], exporters: ["logs"] },
 *     ],
 *   },
 * });
 * ```
 *
 * ### Scaling and Transforming
 * **Example:** OTLP with two replicas and a batch processor
 * ```typescript
 * const pipeline = yield* Azure.Monitor.PipelineGroup("otlp", {
 *   location: "eastus",
 *   customLocationId,
 *   replicas: 2,
 *   receivers: [{ type: "OTLP", name: "otlp", otlp: { endpoint: "0.0.0.0:4317" } }],
 *   processors: [{ type: "Batch", name: "batch", batch: { batchSize: 1000, timeout: 1000 } }],
 *   exporters: [
 *     {
 *       type: "AzureMonitorWorkspaceLogs",
 *       name: "logs",
 *       azureMonitorWorkspaceLogs: {
 *         api: {
 *           dataCollectionEndpointUrl: dceUrl,
 *           dataCollectionRule: dcrImmutableId,
 *           stream: "Custom-Otlp",
 *           schema: { recordMap: [{ from: "body", to: "Body" }] },
 *         },
 *       },
 *     },
 *   ],
 *   service: {
 *     pipelines: [
 *       {
 *         name: "logs",
 *         type: "Logs",
 *         receivers: ["otlp"],
 *         processors: ["batch"],
 *         exporters: ["logs"],
 *       },
 *     ],
 *   },
 *   tags: { site: "factory" },
 * });
 * ```
 *
 * @resource
 */
export const PipelineGroup = GroupedResource<PipelineGroup>("Azure.Monitor.PipelineGroup");

type ObservedPipelineGroup =
  | monitoringservice.GetPipelineGroupResponse
  | monitoringservice.PipelineGroup;

const sameText = (a: string | undefined, b: string | undefined) =>
  (a ?? "").toLowerCase() === (b ?? "").toLowerCase();

const sameLocation = (a: string, b: string) =>
  sameText(a.replaceAll(" ", ""), b.replaceAll(" ", ""));

/**
 * Whether `observed` carries every value set in `desired` (fields the
 * service fills with defaults are not drift). Arrays must match element
 * for element.
 */
const covers = (observed: unknown, desired: unknown): boolean => {
  if (desired === undefined) return true;
  if (Array.isArray(desired)) {
    return (
      Array.isArray(observed) &&
      observed.length === desired.length &&
      desired.every((value, i) => covers(observed[i], value))
    );
  }
  if (desired !== null && typeof desired === "object") {
    if (observed === null || typeof observed !== "object") return false;
    return Object.entries(desired).every(([key, value]) =>
      covers((observed as Record<string, unknown>)[key], value),
    );
  }
  return observed === desired;
};

const createPipelineGroupName = (id: string) =>
  createPhysicalName({ id, maxLength: 63, lowercase: true }).pipe(
    Effect.map((name) => name.replace(/[^a-z0-9-]/g, "-").replace(/^-+|-+$/g, "")),
  );

const getPipelineGroup = (
  subscriptionId: string,
  resourceGroupName: string,
  pipelineGroupName: string,
) =>
  orUndefinedIfNotFound(
    monitoringservice.GetPipelineGroup({
      subscriptionId,
      resourceGroupName,
      pipelineGroupName,
    }),
  );

const desiredProperties = (
  news: PipelineGroupProps,
): monitoringservice.PipelineGroupPropertiesInput => ({
  replicas: news.replicas,
  receivers: news.receivers,
  processors: news.processors ?? [],
  exporters: news.exporters,
  service: news.service,
  executionPlacement: news.executionPlacement,
  tlsConfigurations: news.tlsConfigurations,
});

/** The configuration fields that drifted from the desired props. */
const propertiesDelta = (
  observed: monitoringservice.PipelineGroupProperties | undefined,
  news: PipelineGroupProps,
): monitoringservice.PipelineGroupPropertiesUpdate | undefined => {
  const desired = desiredProperties(news);
  const delta = Object.fromEntries(
    Object.entries(desired).filter(
      ([key, value]) =>
        value !== undefined &&
        !covers(observed?.[key as keyof monitoringservice.PipelineGroupProperties], value),
    ),
  ) as monitoringservice.PipelineGroupPropertiesUpdate;
  return Object.keys(delta).length > 0 ? delta : undefined;
};

const toAttrs = (
  resourceGroup: string,
  name: string,
  group: ObservedPipelineGroup,
): PipelineGroup["Attributes"] => ({
  pipelineGroupName: name,
  resourceGroup,
  pipelineGroupId: group.id ?? "",
  location: group.location,
  customLocationId: group.extendedLocation?.name ?? "",
  provisioningState: group.properties?.provisioningState,
  tags: userTags(group.tags),
});

export const PipelineGroupProvider = () =>
  Provider.succeed(PipelineGroup, {
    stables: ["pipelineGroupName", "resourceGroup", "pipelineGroupId"],

    list: Effect.fn(function* () {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const page = yield* collectAll(monitoringservice.ListPipelineGroupBySubscription, {
        subscriptionId,
      });
      return (page.value ?? []).flatMap((group) => {
        const resourceGroup = resourceGroupOf(group.id);
        return hasAnyAlchemyTag(group.tags) &&
          resourceGroup !== undefined &&
          group.name !== undefined
          ? [toAttrs(resourceGroup, group.name, group)]
          : [];
      });
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        !sameText(news.resourceGroup, output.resourceGroup) ||
        (news.name !== undefined && !sameText(news.name, output.pipelineGroupName)) ||
        (news.location !== undefined && !sameLocation(news.location, output.location)) ||
        !sameText(news.customLocationId, output.customLocationId)
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      if (resourceGroup === undefined) return undefined;
      const name = output?.pipelineGroupName ?? olds?.name ?? (yield* createPipelineGroupName(id));
      const observed = yield* getPipelineGroup(subscriptionId, resourceGroup, name);
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, name, observed);
      return (yield* isOwned(id, observed.tags)) ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* AzureEnvironment.current;
      const { subscriptionId } = env;
      yield* ensureRegistered(subscriptionId, "Microsoft.Monitor");
      const resourceGroup = news.resourceGroup;
      const name = news.name ?? output?.pipelineGroupName ?? (yield* createPipelineGroupName(id));
      const location = news.location ?? output?.location ?? env.location;
      const tags = yield* desiredTags(id, news.tags);
      const where = {
        subscriptionId,
        resourceGroupName: resourceGroup,
        pipelineGroupName: name,
      };
      const get = getPipelineGroup(subscriptionId, resourceGroup, name);

      // Observe.
      const observed = yield* get;

      // Ensure: PUT the full desired body when the pipeline group is missing.
      if (observed === undefined) {
        yield* monitoringservice.PipelineGroupsCreateOrUpdate({
          ...where,
          location,
          tags,
          extendedLocation: {
            name: news.customLocationId,
            type: "CustomLocation",
          },
          properties: desiredProperties(news),
        });
      } else {
        // Sync: PATCH only the drifted configuration and tags.
        const properties = propertiesDelta(observed.properties, news);
        const tagDelta = tagsDiffer(observed.tags, tags);
        if (properties || tagDelta) {
          yield* monitoringservice.UpdatePipelineGroup({
            ...where,
            properties,
            tags: tagDelta ? tags : undefined,
          });
        }
      }

      const final = yield* waitForProvisioned(
        `Azure Monitor pipeline group ${name}`,
        get,
        (group) => group.properties?.provisioningState,
        { interval: "5 seconds", times: 60 },
      );
      return toAttrs(resourceGroup, name, final);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        monitoringservice.DeletePipelineGroup({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          pipelineGroupName: output.pipelineGroupName,
        }),
      );
      yield* waitUntilGone(
        `Azure Monitor pipeline group ${output.pipelineGroupName}`,
        getPipelineGroup(subscriptionId, output.resourceGroup, output.pipelineGroupName),
        { interval: "5 seconds", times: 60 },
      );
    }),

    nuke: { dependsOn: ["Azure.Resources.ResourceGroup"] },
  });
