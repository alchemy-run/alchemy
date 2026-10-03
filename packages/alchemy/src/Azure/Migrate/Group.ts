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

export interface GroupProps {
  /** Resource group of the assessment project. Changing it replaces the group. */
  resourceGroup: string;
  /** Assessment project that holds the group. Changing it replaces the group. */
  assessmentProject: string;
  /**
   * Name of the group. If omitted, a unique name is generated from the app,
   * stage, and logical ID. Changing it replaces the group.
   */
  name?: string;
  /**
   * `Default` groups hold appliance-discovered machines; `Import` groups
   * hold machines imported from CSV. Changing it replaces the group.
   * @default "Default"
   */
  groupType?: "Default" | "Import";
}

export interface Group extends Resource<
  "Azure.Migrate.Group",
  GroupProps,
  {
    /** Name of the group. */
    groupName: string;
    /** Assessment project that holds the group. */
    assessmentProject: string;
    /** Resource group of the assessment project. */
    resourceGroup: string;
    /** ARM resource ID of the group. */
    groupId: string;
    /** Group type (`Default` or `Import`). */
    groupType: string;
    /** Number of machines in the group. */
    machineCount: number;
    /**
     * Assessment types the group's machines support. Azure derives them
     * from the machines added to the group; an empty group reports
     * `Unknown`.
     */
    supportedAssessmentTypes: string[];
  },
  never,
  Providers
> {}

/**
 * A group of machines in an Azure Migrate assessment project
 * (`Microsoft.Migrate/assessmentProjects/groups`) — the scope that
 * assessments evaluate.
 *
 * Machines are added to a group with the `updateMachines` action once an
 * appliance or CSV import has discovered them; this resource manages the
 * group itself. Groups cannot be tagged; Alchemy treats a group as owned
 * when its assessment project carries this stack's and stage's ownership
 * tags.
 *
 * @see https://learn.microsoft.com/azure/migrate/how-to-create-a-group
 *
 * ### Creating a Group
 * **Example:** Group in an assessment project
 * ```typescript
 * const project = yield* Azure.Migrate.AssessmentProject("assess", {
 *   resourceGroup: group.resourceGroupName,
 *   location: "centralus",
 * });
 * const machines = yield* Azure.Migrate.Group("web-tier", {
 *   resourceGroup: group.resourceGroupName,
 *   assessmentProject: project.projectName,
 * });
 * ```
 *
 * ### Grouping Imported Machines
 * **Example:** Group for CSV-imported machines
 * ```typescript
 * const imported = yield* Azure.Migrate.Group("imported", {
 *   resourceGroup: group.resourceGroupName,
 *   assessmentProject: project.projectName,
 *   groupType: "Import",
 * });
 * ```
 *
 * @resource
 */
export const Group = Resource<Group>("Azure.Migrate.Group");

export const getGroup = (
  subscriptionId: string,
  resourceGroupName: string,
  projectName: string,
  groupName: string,
) =>
  orUndefinedIfNotFound(
    migrate.GetGroupsOperation({
      subscriptionId,
      resourceGroupName,
      projectName,
      groupName,
    }),
  );

const toAttrs = (
  resourceGroup: string,
  assessmentProject: string,
  name: string,
  group: migrate.GetGroupsOperationResponse,
): Group["Attributes"] => ({
  groupName: name,
  assessmentProject,
  resourceGroup,
  groupId: group.id ?? "",
  groupType: group.properties?.groupType ?? "Default",
  machineCount: group.properties?.machineCount ?? 0,
  supportedAssessmentTypes: [
    ...(group.properties?.supportedAssessmentTypes ?? []),
  ],
});

export const GroupProvider = () =>
  Provider.succeed(Group, {
    stables: ["groupName", "assessmentProject", "resourceGroup", "groupId"],

    // Groups live inside an assessment project; nuke removes them with it.
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
          news.name.toLowerCase() !== output.groupName.toLowerCase()) ||
        (news.groupType ?? "Default").toLowerCase() !==
          output.groupType.toLowerCase()
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
      const name = output?.groupName ?? olds?.name ?? (yield* migrateName(id));
      const observed = yield* getGroup(
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
      const name = news.name ?? output?.groupName ?? (yield* migrateName(id));
      const get = getGroup(
        subscriptionId,
        resourceGroup,
        assessmentProject,
        name,
      );

      // Observe.
      const observed = yield* get;

      // Ensure. The group type is immutable (diff replaces) and membership
      // is managed by the `updateMachines` action, so there is nothing to
      // sync on an existing group.
      if (observed === undefined) {
        yield* migrate.CreateGroupsOperation({
          subscriptionId,
          resourceGroupName: resourceGroup,
          projectName: assessmentProject,
          groupName: name,
          properties: { groupType: news.groupType ?? "Default" },
        });
      }

      const fresh = yield* waitForProvisioned(
        `assessment group ${name}`,
        get,
        (group) => group.properties?.provisioningState,
      );
      return toAttrs(resourceGroup, assessmentProject, name, fresh);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        migrate.DeleteGroupsOperation({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          projectName: output.assessmentProject,
          groupName: output.groupName,
        }),
      );
      yield* waitUntilGone(
        `assessment group ${output.groupName}`,
        getGroup(
          subscriptionId,
          output.resourceGroup,
          output.assessmentProject,
          output.groupName,
        ),
      );
    }),
  });
