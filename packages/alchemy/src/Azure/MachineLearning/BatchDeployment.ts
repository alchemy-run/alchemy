import * as ml from "@distilled.cloud/azure/machinelearningservices";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import {
  desiredTags,
  ensureRegistered,
  ignoreNotFound,
  isOwned,
  orUndefinedIfNotFound,
  tagsDiffer,
  userTags,
  waitForProvisioned,
  waitUntilGone,
} from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import { containsValue, createChildName, sameArm } from "./Common.ts";

export interface BatchDeploymentProps {
  /** Resource group of the workspace. Changing it replaces the deployment. */
  resourceGroup: string;
  /** Workspace that owns the endpoint. Changing it replaces the deployment. */
  workspace: string;
  /** Batch endpoint the deployment serves. Changing it replaces the deployment. */
  endpoint: string;
  /**
   * Deployment name: 3-32 letters, digits, and hyphens, starting with a
   * letter. If omitted, a unique name is generated from the logical ID.
   * Changing it replaces the deployment.
   */
  name?: string;
  /**
   * Azure location. Changing it replaces the deployment.
   * @default the endpoint's location
   */
  location?: string;
  /** ARM resource ID of the `AmlCompute` cluster that runs scoring jobs. */
  compute: string;
  /**
   * Model to score with: an ARM asset ID (e.g. a registered model
   * version).
   */
  model?: string;
  /** Environment (image + dependencies): an ARM asset ID or `azureml://` URI. */
  environmentId?: string;
  /** Scoring script and code asset (not needed for MLflow models). */
  codeConfiguration?: { codeId?: string; scoringScript: string };
  /** Environment variables of the scoring job. */
  environmentVariables?: Record<string, string>;
  /**
   * Nodes per scoring job.
   * @default 1
   */
  instanceCount?: number;
  /** Parallel scoring processes per node. */
  maxConcurrencyPerInstance?: number;
  /** Files (or rows) per mini batch. */
  miniBatchSize?: number;
  /** Where scoring output goes: `AppendRow` or `SummaryOnly`. */
  outputAction?: "AppendRow" | "SummaryOnly";
  /** Output file name for `AppendRow`. */
  outputFileName?: string;
  /** Failed mini batches tolerated before the job fails (-1 = all). */
  errorThreshold?: number;
  /** Logging level: `Info`, `Warning`, or `Debug`. */
  loggingLevel?: "Info" | "Warning" | "Debug";
  /** Retries per mini batch. */
  retrySettings?: { maxRetries?: number; timeout?: string };
  /** Description of the deployment. */
  description?: string;
  /**
   * User tags. Alchemy ownership tags (`alchemy::stack`, `alchemy::stage`,
   * `alchemy::id`) are merged in automatically.
   */
  tags?: Record<string, string>;
}

export interface BatchDeployment extends Resource<
  "Azure.MachineLearning.BatchDeployment",
  BatchDeploymentProps,
  {
    /** Name of the deployment. */
    deploymentName: string;
    /** ARM resource ID of the deployment. */
    deploymentId: string;
    /** Endpoint the deployment serves. */
    endpoint: string;
    /** Workspace that owns the endpoint. */
    workspace: string;
    /** Resource group of the workspace. */
    resourceGroup: string;
    /** Location of the deployment. */
    location: string;
    /** ARM resource ID of the compute cluster. */
    compute: string | undefined;
    /** User tags (Alchemy ownership tags stripped). */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * A deployment behind an Azure Machine Learning batch endpoint: a model,
 * environment, and scoring code that batch jobs run on an `AmlCompute`
 * cluster. The deployment itself is free; compute is billed only while a
 * job runs.
 *
 * @see https://learn.microsoft.com/azure/machine-learning/how-to-use-batch-model-deployments
 *
 * ### Deploying a Model
 * **Example:** MLflow model on a CPU cluster
 * ```typescript
 * const endpoint = yield* Azure.MachineLearning.BatchEndpoint("nightly", {
 *   resourceGroup: group.resourceGroupName,
 *   workspace: workspace.workspaceName,
 * });
 * const v1 = yield* Azure.MachineLearning.BatchDeployment("v1", {
 *   resourceGroup: group.resourceGroupName,
 *   workspace: workspace.workspaceName,
 *   endpoint: endpoint.endpointName,
 *   compute: cluster.computeId,
 *   model: modelVersionId,
 *   instanceCount: 2,
 *   miniBatchSize: 10,
 * });
 * ```
 *
 * ### Custom Scoring Code
 * **Example:** Scoring script with retries
 * ```typescript
 * const v2 = yield* Azure.MachineLearning.BatchDeployment("v2", {
 *   resourceGroup: group.resourceGroupName,
 *   workspace: workspace.workspaceName,
 *   endpoint: endpoint.endpointName,
 *   compute: cluster.computeId,
 *   model: modelVersionId,
 *   environmentId: environmentAssetId,
 *   codeConfiguration: { codeId: codeAssetId, scoringScript: "batch.py" },
 *   retrySettings: { maxRetries: 3, timeout: "PT5M" },
 * });
 * ```
 *
 * @resource
 */
export const BatchDeployment = Resource<BatchDeployment>(
  "Azure.MachineLearning.BatchDeployment",
);

const getDeployment = (
  subscriptionId: string,
  resourceGroupName: string,
  workspaceName: string,
  endpointName: string,
  deploymentName: string,
) =>
  orUndefinedIfNotFound(
    ml.GetBatchDeployment({
      subscriptionId,
      resourceGroupName,
      workspaceName,
      endpointName,
      deploymentName,
    }),
  );

const toAttrs = (
  resourceGroup: string,
  workspace: string,
  endpoint: string,
  name: string,
  deployment: ml.GetBatchDeploymentResponse,
): BatchDeployment["Attributes"] => ({
  deploymentName: name,
  deploymentId: deployment.id ?? "",
  endpoint,
  workspace,
  resourceGroup,
  location: deployment.location,
  compute: deployment.properties.compute ?? undefined,
  tags: userTags(deployment.tags),
});

const desiredProperties = (news: BatchDeploymentProps) => ({
  compute: news.compute,
  model:
    news.model === undefined
      ? undefined
      : { referenceType: "Id" as const, assetId: news.model },
  environmentId: news.environmentId,
  codeConfiguration: news.codeConfiguration,
  environmentVariables: news.environmentVariables,
  resources: { instanceCount: news.instanceCount ?? 1 },
  maxConcurrencyPerInstance: news.maxConcurrencyPerInstance,
  miniBatchSize: news.miniBatchSize,
  outputAction: news.outputAction,
  outputFileName: news.outputFileName,
  errorThreshold: news.errorThreshold,
  loggingLevel: news.loggingLevel,
  retrySettings: news.retrySettings,
  description: news.description,
});

export const BatchDeploymentProvider = () =>
  Provider.succeed(BatchDeployment, {
    stables: [
      "deploymentName",
      "deploymentId",
      "endpoint",
      "workspace",
      "resourceGroup",
      "location",
    ],

    // Deployments are deleted with their endpoint.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (output === undefined) return undefined;
      // Parent names are stable upstream; an unresolved one means the
      // parent is being replaced.
      if (
        !isResolved(news.resourceGroup) ||
        !isResolved(news.workspace) ||
        !isResolved(news.endpoint)
      ) {
        return { action: "replace" } as const;
      }
      if (!isResolved(news)) return undefined;
      if (
        !sameArm(news.resourceGroup, output.resourceGroup) ||
        !sameArm(news.workspace, output.workspace) ||
        !sameArm(news.endpoint, output.endpoint) ||
        (news.name !== undefined && news.name !== output.deploymentName) ||
        (news.location !== undefined &&
          !sameArm(news.location, output.location))
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      const workspace = output?.workspace ?? olds?.workspace;
      const endpoint = output?.endpoint ?? olds?.endpoint;
      if (
        resourceGroup === undefined ||
        workspace === undefined ||
        endpoint === undefined
      ) {
        return undefined;
      }
      const name =
        output?.deploymentName ??
        olds?.name ??
        (yield* createChildName(id, 32));
      const observed = yield* getDeployment(
        subscriptionId,
        resourceGroup,
        workspace,
        endpoint,
        name,
      );
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, workspace, endpoint, name, observed);
      return (yield* isOwned(id, observed.tags)) ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(
        subscriptionId,
        "Microsoft.MachineLearningServices",
      );
      const { resourceGroup, workspace, endpoint } = news;
      const name =
        news.name ?? output?.deploymentName ?? (yield* createChildName(id, 32));
      const tags = yield* desiredTags(id, news.tags);
      const properties = desiredProperties(news);
      const where = {
        subscriptionId,
        resourceGroupName: resourceGroup,
        workspaceName: workspace,
        endpointName: endpoint,
        deploymentName: name,
      };
      const get = getDeployment(
        subscriptionId,
        resourceGroup,
        workspace,
        endpoint,
        name,
      );
      const waitReady = waitForProvisioned(
        `machine learning batch deployment ${name}`,
        get,
        (deployment) => deployment.properties.provisioningState,
        { interval: "10 seconds", times: 60 },
      );

      // Observe.
      let observed = yield* get;

      // Ensure + sync the deployment definition (PUT is a rolling update).
      if (
        observed === undefined ||
        !containsValue(observed.properties, properties)
      ) {
        const location =
          news.location ??
          output?.location ??
          observed?.location ??
          (yield* ml.GetBatchEndpoint({
            subscriptionId,
            resourceGroupName: resourceGroup,
            workspaceName: workspace,
            endpointName: endpoint,
          })).location;
        yield* ml.BatchDeploymentsCreateOrUpdate({
          ...where,
          location,
          tags,
          properties,
        });
        observed = yield* waitReady;
      }

      // Sync tags (PATCH).
      if (tagsDiffer(observed.tags, tags)) {
        yield* ml.UpdateBatchDeployment({ ...where, tags });
        observed = yield* waitForProvisioned(
          `machine learning batch deployment ${name}`,
          get,
          (deployment) => {
            const state = deployment.properties.provisioningState;
            if (state !== undefined && state !== "Succeeded") return state;
            return tagsDiffer(deployment.tags, tags) ? "Updating" : "Succeeded";
          },
          { interval: "10 seconds", times: 60 },
        );
      }

      return toAttrs(resourceGroup, workspace, endpoint, name, observed);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        ml.DeleteBatchDeployment({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          workspaceName: output.workspace,
          endpointName: output.endpoint,
          deploymentName: output.deploymentName,
        }),
      );
      yield* waitUntilGone(
        `machine learning batch deployment ${output.deploymentName}`,
        getDeployment(
          subscriptionId,
          output.resourceGroup,
          output.workspace,
          output.endpoint,
          output.deploymentName,
        ),
        { interval: "10 seconds", times: 90 },
      );
    }),

    nuke: { dependsOn: ["Azure.MachineLearning.BatchEndpoint"] },
  });
