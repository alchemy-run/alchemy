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

/** Settings of an AKS assessment (target location, pricing, sizing). */
export type AksAssessmentSettings = migrate.AKSAssessmentSettings;

/** Which workloads an AKS assessment covers. */
export type AksAssessmentScope = migrate.AssessmentScopeParameters;

export interface AksAssessmentProps {
  /** Resource group of the assessment project. Changing it replaces the assessment. */
  resourceGroup: string;
  /** Assessment project that holds the assessment. Changing it replaces the assessment. */
  assessmentProject: string;
  /**
   * Name of the assessment. If omitted, a unique name is generated from the
   * app, stage, and logical ID. Changing it replaces the assessment.
   */
  name?: string;
  /**
   * Assessment settings. Changing any of them re-computes the assessment
   * in place.
   */
  settings: AksAssessmentSettings;
  /**
   * Workloads to assess, e.g. `{ scopeType: "ServerGroupId", serverGroupId }`
   * with the ARM ID of a `Migrate.Group`. Changing it re-computes the
   * assessment in place.
   */
  scope?: AksAssessmentScope;
}

export interface AksAssessment extends Resource<
  "Azure.Migrate.AksAssessment",
  AksAssessmentProps,
  {
    /** Name of the assessment. */
    assessmentName: string;
    /** Assessment project that holds the assessment. */
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
 * An Azure Migrate AKS assessment
 * (`Microsoft.Migrate/assessmentProjects/aksAssessments`) — computes the
 * Azure Kubernetes Service clusters and cost needed to containerize
 * discovered web applications.
 *
 * Assessments cannot be tagged; Alchemy treats an assessment as owned when
 * its assessment project carries this stack's and stage's ownership tags.
 *
 * @see https://learn.microsoft.com/azure/migrate/concepts-azure-kubernetes-service-assessment-calculation
 *
 * ### Assessing for AKS
 * **Example:** AKS assessment of a group
 * ```typescript
 * const assessment = yield* Azure.Migrate.AksAssessment("aks", {
 *   resourceGroup: group.resourceGroupName,
 *   assessmentProject: project.projectName,
 *   scope: { scopeType: "ServerGroupId", serverGroupId: machines.groupId },
 *   settings: {
 *     azureLocation: "centralus",
 *     currency: "USD",
 *     environmentType: "Production",
 *     sizingCriterion: "AsOnPremises",
 *     category: "All",
 *     consolidation: "Full",
 *     pricingTier: "Standard",
 *     savingsSettings: { savingsOptions: "None", azureOfferCode: "MSAZR0003P" },
 *     billingSettings: { licensingProgram: "Default" },
 *   },
 * });
 * ```
 *
 * @resource
 */
export const AksAssessment = Resource<AksAssessment>(
  "Azure.Migrate.AksAssessment",
);

const getAksAssessment = (
  subscriptionId: string,
  resourceGroupName: string,
  projectName: string,
  assessmentName: string,
) =>
  orUndefinedIfNotFound(
    migrate.GetAksAssessmentOperation({
      subscriptionId,
      resourceGroupName,
      projectName,
      assessmentName,
    }),
  );

const toAttrs = (
  resourceGroup: string,
  assessmentProject: string,
  name: string,
  assessment: migrate.GetAksAssessmentOperationResponse,
): AksAssessment["Attributes"] => ({
  assessmentName: name,
  assessmentProject,
  resourceGroup,
  assessmentId: assessment.id ?? "",
  status: assessment.properties?.details?.status ?? undefined,
});

export const AksAssessmentProvider = () =>
  Provider.succeed(AksAssessment, {
    stables: [
      "assessmentName",
      "assessmentProject",
      "resourceGroup",
      "assessmentId",
    ],

    // AKS assessments live inside an assessment project; nuke removes them with it.
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
      if (resourceGroup === undefined || project === undefined) {
        return undefined;
      }
      const name =
        output?.assessmentName ?? olds?.name ?? (yield* migrateName(id));
      const observed = yield* getAksAssessment(
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
        news.name ?? output?.assessmentName ?? (yield* migrateName(id));
      const properties = { settings: news.settings, scope: news.scope };
      const get = getAksAssessment(
        subscriptionId,
        resourceGroup,
        assessmentProject,
        name,
      );

      // Observe.
      const observed = yield* get;

      // Ensure + sync: the PUT creates the assessment or re-computes it with
      // the new settings.
      if (
        observed === undefined ||
        settingsDiffer(properties, observed.properties)
      ) {
        yield* migrate.CreateAksAssessmentOperation({
          subscriptionId,
          resourceGroupName: resourceGroup,
          projectName: assessmentProject,
          assessmentName: name,
          properties,
        });
      }

      const fresh = yield* waitForProvisioned(
        `AKS assessment ${name}`,
        get,
        (assessment) => assessment.properties?.provisioningState,
      );
      return toAttrs(resourceGroup, assessmentProject, name, fresh);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        migrate.DeleteAksAssessmentOperation({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          projectName: output.assessmentProject,
          assessmentName: output.assessmentName,
        }),
      );
      yield* waitUntilGone(
        `AKS assessment ${output.assessmentName}`,
        getAksAssessment(
          subscriptionId,
          output.resourceGroup,
          output.assessmentProject,
          output.assessmentName,
        ),
      );
    }),
  });
