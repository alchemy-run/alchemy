import * as monitoringservice from "@distilled.cloud/azure/monitoringservice";
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

/** A pipeline group receiver (Syslog or OTLP listener). */
export type PipelineGroupReceiver = monitoringservice.Receiver;
/** A pipeline group processor (batch or KQL transform). */
export type PipelineGroupProcessor = monitoringservice.Processor;
/** A pipeline group exporter (Azure Monitor workspace logs). */
export type PipelineGroupExporter = monitoringservice.Exporter;
/** The pipelines wiring receivers, processors, and exporters together. */
export type PipelineGroupService = monitoringservice.Service;
/** Placement constraints for the pipeline group's instances. */
export type PipelineGroupExecutionPlacement =
  monitoringservice.ExecutionPlacement;
/** A named TLS configuration referenced by receivers. */
export type PipelineGroupTlsConfiguration = monitoringservice.TlsConfiguration;

export interface PipelineGroupProps {
  /**
   * Resource group the pipeline group is created in. Changing it replaces
   * the pipeline group.
   */
  resourceGroup: string;
  /**
   * Pipeline group name. If omitted, a unique name is generated from the
   * app, stage, and logical ID. Changing it replaces the pipeline group.
   */
  name?: string;
  /**
   * Azure location of the pipeline group (the custom location's region).
   * Changing it replaces the pipeline group.
   * @default the `Azure.Location` layer, else the profile location, else `eastus`
   */
  location?: string;
  /**
   * ARM resource ID of the Azure Arc custom location
   * (`Microsoft.ExtendedLocation/customLocations`) on the Arc-enabled
   * Kubernetes cluster that runs the pipeline. Changing it replaces the
   * pipeline group.
   */
  customLocationId: string;
  /** Number of replicas of the pipeline group instance. */
  replicas?: number;
  /** Receivers (Syslog / OTLP listeners) of the pipeline group. */
  receivers: PipelineGroupReceiver[];
  /**
   * Processors (batch / transform) of the pipeline group.
   * @default []
   */
  processors?: PipelineGroupProcessor[];
  /** Exporters sending data to Azure Monitor. */
  exporters: PipelineGroupExporter[];
  /** Pipelines connecting receivers, processors, and exporters. */
  service: PipelineGroupService;
  /** Placement constraints for the pipeline group's instances. */
  executionPlacement?: PipelineGroupExecutionPlacement;
  /** Named TLS configurations referenced by receivers. */
  tlsConfigurations?: PipelineGroupTlsConfiguration[];
  /**
   * User tags. Alchemy ownership tags (`alchemy::stack`, `alchemy::stage`,
   * `alchemy::id`) are merged in automatically.
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
 * An Azure Monitor pipeline group — an Azure Monitor pipeline at the edge
 * that receives Syslog/OTLP telemetry on an Arc-enabled Kubernetes cluster,
 * optionally batches or transforms it, and forwards it to Azure Monitor
 * through a data collection rule.
 *
 * Requires an Azure Arc-enabled Kubernetes cluster with the Azure Monitor
 * pipeline extension installed and a custom location on it.
 *
 * @see https://learn.microsoft.com/azure/azure-monitor/essentials/edge-pipeline-configure
 *
 * ### Creating a Pipeline Group
 * **Example:** Syslog to a Log Analytics table through a DCR
 * ```typescript
 * const pipeline = yield* Azure.Monitor.PipelineGroup("edge", {
 *   resourceGroup: group.resourceGroupName,
 *   location: "eastus",
 *   customLocationId: customLocation.id,
 *   receivers: [
 *     {
 *       type: "Syslog",
 *       name: "syslog",
 *       syslog: { endpoint: "0.0.0.0:514" },
 *     },
 *   ],
 *   processors: [],
 *   exporters: [
 *     {
 *       type: "AzureMonitorWorkspaceLogs",
 *       name: "logs",
 *       azureMonitorWorkspaceLogs: {
 *         api: {
 *           dataCollectionEndpointUrl: dce.logsIngestionEndpoint,
 *           dataCollectionRule: dcr.immutableId,
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
 * @resource
 */
export const PipelineGroup = Resource<PipelineGroup>(
  "Azure.Monitor.PipelineGroup",
);

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
    Effect.map((name) =>
      name.replace(/[^a-z0-9-]/g, "-").replace(/^-+|-+$/g, ""),
    ),
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
        !covers(
          observed?.[key as keyof monitoringservice.PipelineGroupProperties],
          value,
        ),
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
      const page = yield* monitoringservice
        .ListPipelineGroupBySubscription({ subscriptionId })
        .pipe(
          Effect.flatMap((page) =>
            requireSinglePage("ListPipelineGroupBySubscription", page),
          ),
        );
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
        (news.name !== undefined &&
          !sameText(news.name, output.pipelineGroupName)) ||
        (news.location !== undefined &&
          !sameLocation(news.location, output.location)) ||
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
      const name =
        output?.pipelineGroupName ??
        olds?.name ??
        (yield* createPipelineGroupName(id));
      const observed = yield* getPipelineGroup(
        subscriptionId,
        resourceGroup,
        name,
      );
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, name, observed);
      return (yield* isOwned(id, observed.tags)) ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* AzureEnvironment.current;
      const { subscriptionId } = env;
      yield* ensureRegistered(subscriptionId, "Microsoft.Monitor");
      const resourceGroup = news.resourceGroup;
      const name =
        news.name ??
        output?.pipelineGroupName ??
        (yield* createPipelineGroupName(id));
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
        getPipelineGroup(
          subscriptionId,
          output.resourceGroup,
          output.pipelineGroupName,
        ),
        { interval: "5 seconds", times: 60 },
      );
    }),

    nuke: { dependsOn: ["Azure.Resources.ResourceGroup"] },
  });
