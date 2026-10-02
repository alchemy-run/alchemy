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
import { migrateName, ownedByStage } from "./Common.ts";

export interface ImportCollectorProps {
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
   * ARM ID of the discovery site the collector reads inventory from.
   * Changing it replaces the collector.
   */
  discoverySiteId?: string;
}

export interface ImportCollector extends Resource<
  "Azure.Migrate.ImportCollector",
  ImportCollectorProps,
  {
    /** Name of the collector. */
    collectorName: string;
    /** Assessment project that holds the collector. */
    assessmentProject: string;
    /** Resource group of the assessment project. */
    resourceGroup: string;
    /** ARM resource ID of the collector. */
    collectorId: string;
    /** ARM ID of the discovery site the collector reads, if any. */
    discoverySiteId: string | undefined;
  },
  never,
  Providers
> {}

/**
 * An Azure Migrate import collector
 * (`Microsoft.Migrate/assessmentProjects/importcollectors`) — connects an
 * assessment project to an import site so machines imported from CSV can
 * be assessed. No appliance is involved.
 *
 * Collectors cannot be tagged; Alchemy treats a collector as owned when its
 * assessment project carries this stack's and stage's ownership tags.
 *
 * @see https://learn.microsoft.com/azure/migrate/migrate-appliance-architecture
 *
 * ### Connecting an Import Site
 * **Example:** Collector for an import site
 * ```typescript
 * const site = yield* Azure.Migrate.ImportSite("imports-site", {
 *   resourceGroup: group.resourceGroupName,
 *   location: "centralus",
 * });
 * const collector = yield* Azure.Migrate.ImportCollector("imports", {
 *   resourceGroup: group.resourceGroupName,
 *   assessmentProject: project.projectName,
 *   discoverySiteId: site.siteId,
 * });
 * ```
 *
 * @resource
 */
export const ImportCollector = Resource<ImportCollector>(
  "Azure.Migrate.ImportCollector",
);

const getImportCollector = (
  subscriptionId: string,
  resourceGroupName: string,
  projectName: string,
  name: string,
) =>
  orUndefinedIfNotFound(
    migrate.GetImportCollectorsOperation({
      subscriptionId,
      resourceGroupName,
      projectName,
      importCollectorName: name,
    }),
  );

const toAttrs = (
  resourceGroup: string,
  assessmentProject: string,
  name: string,
  collector: migrate.GetImportCollectorsOperationResponse,
): ImportCollector["Attributes"] => ({
  collectorName: name,
  assessmentProject,
  resourceGroup,
  collectorId: collector.id ?? "",
  discoverySiteId: collector.properties?.discoverySiteId ?? undefined,
});

export const ImportCollectorProvider = () =>
  Provider.succeed(ImportCollector, {
    stables: [
      "collectorName",
      "assessmentProject",
      "resourceGroup",
      "collectorId",
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
      const observed = yield* getImportCollector(
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
      const properties = { discoverySiteId: news.discoverySiteId };
      const get = getImportCollector(
        subscriptionId,
        resourceGroup,
        assessmentProject,
        name,
      );

      // Observe.
      const observed = yield* get;

      // Ensure. The only property (the discovery site) is immutable, so an
      // existing collector needs no sync.
      if (observed === undefined) {
        yield* migrate.CreateImportCollectorsOperation({
          subscriptionId,
          resourceGroupName: resourceGroup,
          projectName: assessmentProject,
          importCollectorName: name,
          properties,
        });
      }

      const fresh = yield* waitForProvisioned(
        `import collector ${name}`,
        get,
        (collector) => collector.properties?.provisioningState,
      );
      return toAttrs(resourceGroup, assessmentProject, name, fresh);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        migrate.DeleteImportCollectorsOperation({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          projectName: output.assessmentProject,
          importCollectorName: output.collectorName,
        }),
      );
      yield* waitUntilGone(
        `import collector ${output.collectorName}`,
        getImportCollector(
          subscriptionId,
          output.resourceGroup,
          output.assessmentProject,
          output.collectorName,
        ),
      );
    }),
  });
