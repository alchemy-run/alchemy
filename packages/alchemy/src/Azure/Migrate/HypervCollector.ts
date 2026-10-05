import * as migrate from "@distilled.cloud/azure/migrate";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
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
import { getAssessmentProject } from "./AssessmentProject.ts";
import { migrateName, ownedByStage, settingsDiffer } from "./Common.ts";
import type { CollectorServicePrincipal } from "./Types.ts";

export interface HypervCollectorProps {
  /** Resource group of the assessment project. Changing it replaces the collector. */
  resourceGroup: string;
  /** Assessment project the collector feeds. Changing it replaces the collector. */
  assessmentProject: string;
  /**
   * Name of the collector. If omitted, a unique name is generated from the
   * app, stage, and logical ID. Changing it replaces the collector.
   */
  name?: string;
  /**
   * ID of the appliance agent that reports through this collector — the
   * `agentId` of the discovery site the appliance registered. An agent can
   * back only one collector. Changing it replaces the collector.
   */
  agentId: string;
  /**
   * ARM ID of the discovery site the collector reads inventory from.
   * Changing it replaces the collector.
   */
  discoverySiteId?: string;
  /** Microsoft Entra application the appliance agent authenticates with. */
  servicePrincipal?: CollectorServicePrincipal;
}

export interface HypervCollector extends Resource<
  "Azure.Migrate.HypervCollector",
  HypervCollectorProps,
  {
    /** Name of the collector. */
    collectorName: string;
    /** Assessment project that holds the collector. */
    assessmentProject: string;
    /** Resource group of the assessment project. */
    resourceGroup: string;
    /** ARM resource ID of the collector. */
    collectorId: string;
    /** ID of the appliance agent registered with the collector. */
    agentId: string;
    /** ARM ID of the discovery site the collector reads, if any. */
    discoverySiteId: string | undefined;
    /** Last heartbeat of the appliance agent (ISO-8601), if it has reported. */
    lastHeartbeatUtc: string | undefined;
  },
  never,
  Providers
> {}

/**
 * An Azure Migrate Hyper-V collector (`Microsoft.Migrate/assessmentProjects/hypervcollectors`)
 * — registers an on-premises appliance agent with an assessment project so
 * the Hyper-V inventory it discovers can be assessed.
 *
 * The collector is a control-plane registration: it becomes useful once the
 * appliance whose agent it names starts sending heartbeats. Collectors
 * cannot be tagged; Alchemy treats a collector as owned when its
 * assessment project carries this stack's and stage's ownership tags.
 *
 * @see https://learn.microsoft.com/azure/migrate/migrate-appliance-architecture
 *
 * ### Registering an Appliance Agent
 * **Example:** Collector for a discovery site's agent
 * ```typescript
 * const site = yield* Azure.Migrate.HypervSite("hyperv-site", {
 *   resourceGroup: group.resourceGroupName,
 *   location: "centralus",
 * });
 * const collector = yield* Azure.Migrate.HypervCollector("hyperv", {
 *   resourceGroup: group.resourceGroupName,
 *   assessmentProject: project.projectName,
 *   agentId: site.agentId,
 *   discoverySiteId: site.siteId,
 *   servicePrincipal: {
 *     tenantId: "<tenant-id>",
 *     applicationId: "<app-id>",
 *     objectId: "<object-id>",
 *     audience: "<app-id>",
 *     authority: "https://login.windows.net/<tenant-id>",
 *   },
 * });
 * ```
 *
 * @resource
 */
export const HypervCollector = Resource<HypervCollector>(
  "Azure.Migrate.HypervCollector",
);

const getHypervCollector = (
  subscriptionId: string,
  resourceGroupName: string,
  projectName: string,
  name: string,
) =>
  orUndefinedIfNotFound(
    migrate.GetHypervCollectorsOperation({
      subscriptionId,
      resourceGroupName,
      projectName,
      hypervCollectorName: name,
    }),
  );

const toAttrs = (
  resourceGroup: string,
  assessmentProject: string,
  name: string,
  collector: migrate.GetHypervCollectorsOperationResponse,
): HypervCollector["Attributes"] => ({
  collectorName: name,
  assessmentProject,
  resourceGroup,
  collectorId: collector.id ?? "",
  agentId: collector.properties?.agentProperties?.id ?? "",
  discoverySiteId: collector.properties?.discoverySiteId ?? undefined,
  lastHeartbeatUtc:
    collector.properties?.agentProperties?.lastHeartbeatUtc ?? undefined,
});

export const HypervCollectorProvider = () =>
  Provider.succeed(HypervCollector, {
    stables: [
      "collectorName",
      "assessmentProject",
      "resourceGroup",
      "collectorId",
      "agentId",
    ],

    // Collectors live inside an assessment project; nuke removes them with it.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        news.resourceGroup.toLowerCase() !==
          output.resourceGroup.toLowerCase() ||
        news.assessmentProject.toLowerCase() !==
          output.assessmentProject.toLowerCase() ||
        (news.name !== undefined &&
          news.name.toLowerCase() !== output.collectorName.toLowerCase()) ||
        news.agentId !== output.agentId ||
        (news.discoverySiteId ?? "").toLowerCase() !==
          (output.discoverySiteId ?? "").toLowerCase()
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      const project = output?.assessmentProject ?? olds?.assessmentProject;
      if (resourceGroup === undefined || project === undefined) {
        return undefined;
      }
      const name =
        output?.collectorName ?? olds?.name ?? (yield* migrateName(id));
      const observed = yield* getHypervCollector(
        subscriptionId,
        resourceGroup,
        project,
        name,
      );
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, project, name, observed);
      const parent = yield* getAssessmentProject(
        subscriptionId,
        resourceGroup,
        project,
      );
      return (yield* ownedByStage(parent?.tags)) ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, "Microsoft.Migrate");
      const { resourceGroup, assessmentProject } = news;
      const name =
        news.name ?? output?.collectorName ?? (yield* migrateName(id));
      const properties = {
        agentProperties: {
          id: news.agentId,
          spnDetails: news.servicePrincipal,
        },
        discoverySiteId: news.discoverySiteId,
      };
      const get = getHypervCollector(
        subscriptionId,
        resourceGroup,
        assessmentProject,
        name,
      );

      // Observe.
      const observed = yield* get;

      // Ensure + sync: the PUT is a create-or-update of the whole collector,
      // so it also applies service-principal changes.
      if (
        observed === undefined ||
        settingsDiffer(properties, observed.properties)
      ) {
        yield* migrate.CreateHypervCollectorsOperation({
          subscriptionId,
          resourceGroupName: resourceGroup,
          projectName: assessmentProject,
          hypervCollectorName: name,
          properties,
        });
      }

      const fresh = yield* waitForProvisioned(
        `Hyper-V collector ${name}`,
        get,
        (collector) => collector.properties?.provisioningState,
      );
      return toAttrs(resourceGroup, assessmentProject, name, fresh);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        migrate.DeleteHypervCollectorsOperation({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          projectName: output.assessmentProject,
          hypervCollectorName: output.collectorName,
        }),
      );
      yield* waitUntilGone(
        `Hyper-V collector ${output.collectorName}`,
        getHypervCollector(
          subscriptionId,
          output.resourceGroup,
          output.assessmentProject,
          output.collectorName,
        ),
      );
    }),
  });
