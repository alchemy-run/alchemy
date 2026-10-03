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
import { migrateName, ownedByStage, settingsDiffer } from "./Common.ts";
import { getMigrateProject } from "./MigrateProject.ts";

export type SolutionTool =
  | "ServerDiscovery"
  | "ServerAssessment"
  | "ServerMigration"
  | "Cloudamize"
  | "Turbonomic"
  | "Zerto"
  | "CorentTech"
  | "ServerAssessmentV1"
  | "ServerMigration_Replication"
  | "Carbonite"
  | "DataMigrationAssistant"
  | "DatabaseMigrationService"
  | "Device42"
  | "JetStream"
  | "RackWare"
  | "UnifyCloud"
  | "Flexera"
  | "ServerDiscovery_Import"
  | "Lakeside"
  | "AppServiceMigrationAssistant"
  | "Movere"
  | "CloudSphere"
  | "Modernization"
  | "ServerMigration_DataReplication"
  | (string & {});

export interface SolutionProps {
  /** Resource group of the Migrate project. Changing it replaces the solution. */
  resourceGroup: string;
  /** Migrate project the solution registers with. Changing it replaces the solution. */
  migrateProject: string;
  /**
   * Name of the solution. The portal names solutions
   * `<Goal>-<Purpose>-<Tool>` (e.g. `Servers-Assessment-ServerAssessment`).
   * If omitted, a unique name is generated from the app, stage, and logical
   * ID. Changing it replaces the solution.
   */
  name?: string;
  /** Tool the solution represents. Changing it replaces the solution. */
  tool: SolutionTool;
  /** What the tool is used for. Changing it replaces the solution. */
  purpose: "Discovery" | "Assessment" | "Migration";
  /** Workload the tool targets. Changing it replaces the solution. */
  goal:
    | "Servers"
    | "Databases"
    | "DesktopVirtualization"
    | "WebApplications"
    | "DataCenter";
  /**
   * Whether the tool is in use.
   * @default "Active"
   */
  status?: "Active" | "Inactive";
  /** Free-form key/value details the tool reports to the hub. */
  extendedDetails?: Record<string, string>;
}

export interface Solution extends Resource<
  "Azure.Migrate.Solution",
  SolutionProps,
  {
    /** Name of the solution. */
    solutionName: string;
    /** Migrate project that holds the solution. */
    migrateProject: string;
    /** Resource group of the Migrate project. */
    resourceGroup: string;
    /** ARM resource ID of the solution; use it as a site's `discoverySolutionId`. */
    solutionId: string;
    /** Tool the solution represents. */
    tool: string;
    /** What the tool is used for. */
    purpose: string;
    /** Workload the tool targets. */
    goal: string;
    /** Whether the tool is in use. */
    status: string;
    /** Free-form details reported to the hub. */
    extendedDetails: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * A tool registered with an Azure Migrate project
 * (`Microsoft.Migrate/migrateProjects/solutions`) — e.g. the Azure Migrate
 * discovery, assessment, or migration tool, or an ISV tool such as
 * Turbonomic.
 *
 * Solutions cannot be tagged; Alchemy treats a solution as owned when its
 * Migrate project carries this stack's and stage's ownership tags.
 *
 * @see https://learn.microsoft.com/azure/migrate/migrate-services-overview
 *
 * ### Registering a Tool
 * **Example:** Server assessment tool
 * ```typescript
 * const hub = yield* Azure.Migrate.MigrateProject("hub", {
 *   resourceGroup: group.resourceGroupName,
 *   location: "centralus",
 * });
 * const assessment = yield* Azure.Migrate.Solution("assessment", {
 *   resourceGroup: group.resourceGroupName,
 *   migrateProject: hub.migrateProjectName,
 *   name: "Servers-Assessment-ServerAssessment",
 *   tool: "ServerAssessment",
 *   purpose: "Assessment",
 *   goal: "Servers",
 * });
 * ```
 *
 * ### Linking a Discovery Site
 * **Example:** Discovery tool tracking a VMware site
 * ```typescript
 * const discovery = yield* Azure.Migrate.Solution("discovery", {
 *   resourceGroup: group.resourceGroupName,
 *   migrateProject: hub.migrateProjectName,
 *   name: "Servers-Discovery-ServerDiscovery",
 *   tool: "ServerDiscovery",
 *   purpose: "Discovery",
 *   goal: "Servers",
 * });
 * const site = yield* Azure.Migrate.VmwareSite("vmware", {
 *   resourceGroup: group.resourceGroupName,
 *   location: "centralus",
 *   discoverySolutionId: discovery.solutionId,
 * });
 * ```
 *
 * @resource
 */
export const Solution = Resource<Solution>("Azure.Migrate.Solution");

const getSolution = (
  subscriptionId: string,
  resourceGroupName: string,
  migrateProjectName: string,
  solutionName: string,
) =>
  orUndefinedIfNotFound(
    migrate.GetSolutionsControllerSolution({
      subscriptionId,
      resourceGroupName,
      migrateProjectName,
      solutionName,
    }),
  );

const toAttrs = (
  resourceGroup: string,
  migrateProject: string,
  name: string,
  solution: migrate.Solution,
): Solution["Attributes"] => ({
  solutionName: name,
  migrateProject,
  resourceGroup,
  solutionId: solution.id ?? "",
  tool: solution.properties?.tool ?? "",
  purpose: solution.properties?.purpose ?? "",
  goal: solution.properties?.goal ?? "",
  status: solution.properties?.status ?? "",
  extendedDetails: Object.fromEntries(
    Object.entries(solution.properties?.details?.extendedDetails ?? {}).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  ),
});

export const SolutionProvider = () =>
  Provider.succeed(Solution, {
    stables: ["solutionName", "migrateProject", "resourceGroup", "solutionId"],

    // Solutions live inside a Migrate project; nuke removes them with it.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        news.resourceGroup.toLowerCase() !==
          output.resourceGroup.toLowerCase() ||
        news.migrateProject.toLowerCase() !==
          output.migrateProject.toLowerCase() ||
        (news.name !== undefined &&
          news.name.toLowerCase() !== output.solutionName.toLowerCase()) ||
        news.tool.toLowerCase() !== output.tool.toLowerCase() ||
        news.purpose.toLowerCase() !== output.purpose.toLowerCase() ||
        news.goal.toLowerCase() !== output.goal.toLowerCase()
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      const migrateProject = output?.migrateProject ?? olds?.migrateProject;
      if (resourceGroup === undefined || migrateProject === undefined) {
        return undefined;
      }
      const name =
        output?.solutionName ?? olds?.name ?? (yield* migrateName(id));
      const observed = yield* getSolution(
        subscriptionId,
        resourceGroup,
        migrateProject,
        name,
      );
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, migrateProject, name, observed);
      const parent = yield* getMigrateProject(
        subscriptionId,
        resourceGroup,
        migrateProject,
      );
      return (yield* ownedByStage(parent?.tags)) ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, "Microsoft.Migrate");
      const { resourceGroup, migrateProject } = news;
      const name =
        news.name ?? output?.solutionName ?? (yield* migrateName(id));
      const properties = {
        tool: news.tool,
        purpose: news.purpose,
        goal: news.goal,
        status: news.status ?? "Active",
        details:
          news.extendedDetails === undefined
            ? undefined
            : { extendedDetails: news.extendedDetails },
      };
      const get = getSolution(
        subscriptionId,
        resourceGroup,
        migrateProject,
        name,
      );

      // Observe.
      const observed = yield* get;

      // Ensure + sync: the PUT is a create-or-update of the whole solution.
      if (
        observed === undefined ||
        settingsDiffer(properties, observed.properties)
      ) {
        yield* migrate.CreateSolutionsController({
          subscriptionId,
          resourceGroupName: resourceGroup,
          migrateProjectName: migrateProject,
          solutionName: name,
          properties,
        });
      }

      const fresh = yield* waitForProvisioned(
        `migrate solution ${name}`,
        get,
        () => undefined,
        { interval: "2 seconds", times: 15 },
      );
      return toAttrs(resourceGroup, migrateProject, name, fresh);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const get = getSolution(
        subscriptionId,
        output.resourceGroup,
        output.migrateProject,
        output.solutionName,
      );
      // Deleting a missing solution fails with a 502 instead of a 404, so
      // only delete what is observed.
      if ((yield* get) === undefined) return;
      yield* ignoreNotFound(
        migrate.DeleteSolutionsControllerSolution({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          migrateProjectName: output.migrateProject,
          solutionName: output.solutionName,
        }),
      );
      yield* waitUntilGone(`migrate solution ${output.solutionName}`, get);
    }),
  });
