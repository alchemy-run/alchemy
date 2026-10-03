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

/** Settings of an Azure VM assessment (target location, pricing, sizing). */
export type AssessmentSettings = Omit<
  migrate.MachineAssessmentPropertiesInput,
  "provisioningState"
>;

export interface AssessmentProps {
  /** Resource group of the assessment project. Changing it replaces the assessment. */
  resourceGroup: string;
  /** Assessment project of the group. Changing it replaces the assessment. */
  assessmentProject: string;
  /** Group of machines to assess. Changing it replaces the assessment. */
  group: string;
  /**
   * Name of the assessment. If omitted, a unique name is generated from the
   * app, stage, and logical ID. Changing it replaces the assessment.
   */
  name?: string;
  /**
   * Assessment settings. Changing any of them re-computes the assessment
   * in place. Fields left out take the service defaults.
   */
  settings?: AssessmentSettings;
}

export interface Assessment extends Resource<
  "Azure.Migrate.Assessment",
  AssessmentProps,
  {
    /** Name of the assessment. */
    assessmentName: string;
    /** Group the assessment evaluates. */
    group: string;
    /** Assessment project of the group. */
    assessmentProject: string;
    /** Resource group of the assessment project. */
    resourceGroup: string;
    /** ARM resource ID of the assessment. */
    assessmentId: string;
    /** Computation status of the assessment (e.g. `Completed`, `Invalid`). */
    status: string | undefined;
  },
  never,
  Providers
> {}

/**
 * An Azure Migrate Azure VM assessment
 * (`Microsoft.Migrate/assessmentProjects/groups/assessments`) — computes
 * Azure VM sizing, readiness, and monthly cost for the group's machines.
 *
 * The group must contain discovered or imported machines that support this
 * assessment type; Azure rejects an assessment of an empty group with
 * `MigrateAssessmentTypeNotSupported`. Assessments cannot be tagged;
 * Alchemy treats an assessment as owned when its assessment project
 * carries this stack's and stage's ownership tags.
 *
 * @see https://learn.microsoft.com/azure/migrate/how-to-create-assessment
 *
 * ### Assessing a Group
 * **Example:** Azure VM assessment
 * ```typescript
 * const assessment = yield* Azure.Migrate.Assessment("assessment", {
 *   resourceGroup: group.resourceGroupName,
 *   assessmentProject: project.projectName,
 *   group: machines.groupName,
 *   settings: {
 *     azureLocation: "centralus",
 *     currency: "USD",
 *     sizingCriterion: "PerformanceBased",
 *     percentile: "Percentile95",
 *     timeRange: "Month",
 *     azureHybridUseBenefit: "Yes",
 *   },
 * });
 * ```
 *
 * @resource
 */
export const Assessment = Resource<Assessment>("Azure.Migrate.Assessment");

const getAssessment = (
  subscriptionId: string,
  resourceGroupName: string,
  projectName: string,
  groupName: string,
  assessmentName: string,
) =>
  orUndefinedIfNotFound(
    migrate.GetAssessmentsOperation({
      subscriptionId,
      resourceGroupName,
      projectName,
      groupName,
      assessmentName,
    }),
  );

const toAttrs = (
  resourceGroup: string,
  assessmentProject: string,
  group: string,
  name: string,
  assessment: migrate.GetAssessmentsOperationResponse,
): Assessment["Attributes"] => ({
  assessmentName: name,
  group,
  assessmentProject,
  resourceGroup,
  assessmentId: assessment.id ?? "",
  status: assessment.properties?.status ?? undefined,
});

export const AssessmentProvider = () =>
  Provider.succeed(Assessment, {
    stables: [
      "assessmentName",
      "group",
      "assessmentProject",
      "resourceGroup",
      "assessmentId",
    ],

    // Assessments live inside an assessment project; nuke removes them with it.
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
        news.group.toLowerCase() !== output.group.toLowerCase() ||
        (news.name !== undefined &&
          news.name.toLowerCase() !== output.assessmentName.toLowerCase())
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      const project = output?.assessmentProject ?? olds?.assessmentProject;
      const group = output?.group ?? olds?.group;
      if (
        resourceGroup === undefined ||
        project === undefined ||
        group === undefined
      ) {
        return undefined;
      }
      const name =
        output?.assessmentName ?? olds?.name ?? (yield* migrateName(id));
      const observed = yield* getAssessment(
        subscriptionId,
        resourceGroup,
        project,
        group,
        name,
      );
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, project, group, name, observed);
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
      const { resourceGroup, assessmentProject, group } = news;
      const name =
        news.name ?? output?.assessmentName ?? (yield* migrateName(id));
      const settings = news.settings ?? {};
      const get = getAssessment(
        subscriptionId,
        resourceGroup,
        assessmentProject,
        group,
        name,
      );

      // Observe.
      const observed = yield* get;

      // Ensure + sync: the PUT creates the assessment or re-computes it with
      // the new settings.
      if (
        observed === undefined ||
        settingsDiffer(settings, observed.properties)
      ) {
        yield* migrate.CreateAssessmentsOperation({
          subscriptionId,
          resourceGroupName: resourceGroup,
          projectName: assessmentProject,
          groupName: group,
          assessmentName: name,
          properties: settings,
        });
      }

      const fresh = yield* waitForProvisioned(
        `Azure VM assessment ${name}`,
        get,
        (assessment) => assessment.properties?.provisioningState,
      );
      return toAttrs(resourceGroup, assessmentProject, group, name, fresh);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        migrate.DeleteAssessmentsOperation({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          projectName: output.assessmentProject,
          groupName: output.group,
          assessmentName: output.assessmentName,
        }),
      );
      yield* waitUntilGone(
        `Azure VM assessment ${output.assessmentName}`,
        getAssessment(
          subscriptionId,
          output.resourceGroup,
          output.assessmentProject,
          output.group,
          output.assessmentName,
        ),
      );
    }),
  });
