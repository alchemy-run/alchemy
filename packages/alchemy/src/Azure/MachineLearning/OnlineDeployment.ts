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

export interface OnlineDeploymentProbe {
  /** Consecutive failures before the probe fails. */
  failureThreshold?: number;
  /** Delay before the first probe, as an ISO 8601 duration. */
  initialDelay?: string;
  /** Interval between probes, as an ISO 8601 duration. */
  period?: string;
  /** Consecutive successes before the probe succeeds. */
  successThreshold?: number;
  /** Probe timeout, as an ISO 8601 duration. */
  timeout?: string;
}

export interface OnlineDeploymentProps {
  /** Resource group of the workspace. Changing it replaces the deployment. */
  resourceGroup: string;
  /** Workspace that owns the endpoint. Changing it replaces the deployment. */
  workspace: string;
  /** Online endpoint the deployment serves. Changing it replaces the deployment. */
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
  /**
   * Where the deployment runs. Changing it replaces the deployment.
   * @default "Managed"
   */
  endpointComputeType?: "Managed" | "Kubernetes";
  /**
   * VM SKU of each instance, e.g. `Standard_DS3_v2`. Changing it replaces
   * the deployment.
   */
  instanceType?: string;
  /**
   * Number of instances.
   * @default 1
   */
  instanceCount?: number;
  /**
   * Model to serve: an ARM asset ID or an `azureml://` URI (e.g. a model
   * from the `azureml` registry).
   */
  model?: string;
  /** Environment (image + dependencies): an ARM asset ID or `azureml://` URI. */
  environmentId?: string;
  /** Scoring script and code asset (not needed for MLflow models). */
  codeConfiguration?: { codeId?: string; scoringScript: string };
  /** Environment variables of the scoring container. */
  environmentVariables?: Record<string, string>;
  /** Request concurrency and timeouts. */
  requestSettings?: {
    maxConcurrentRequestsPerInstance?: number;
    maxQueueWait?: string;
    requestTimeout?: string;
  };
  /** Liveness probe of the scoring container. */
  livenessProbe?: OnlineDeploymentProbe;
  /** Readiness probe of the scoring container. */
  readinessProbe?: OnlineDeploymentProbe;
  /**
   * Send scoring logs and metrics to the workspace's Application Insights.
   * @default false
   */
  appInsightsEnabled?: boolean;
  /**
   * Whether the deployment can reach the internet.
   * @default Azure's default (`Enabled`)
   */
  egressPublicNetworkAccess?: "Enabled" | "Disabled";
  /** Description of the deployment. */
  description?: string;
  /**
   * User tags. Alchemy ownership tags (`alchemy::stack`, `alchemy::stage`,
   * `alchemy::id`) are merged in automatically.
   */
  tags?: Record<string, string>;
}

export interface OnlineDeployment extends Resource<
  "Azure.MachineLearning.OnlineDeployment",
  OnlineDeploymentProps,
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
    /** Compute type (`Managed` or `Kubernetes`). */
    endpointComputeType: string;
    /** VM SKU of each instance. */
    instanceType: string | undefined;
    /** Number of instances. */
    instanceCount: number | undefined;
    /** User tags (Alchemy ownership tags stripped). */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * A deployment behind an Azure Machine Learning online endpoint: a model,
 * environment, and scoring code running on dedicated managed instances
 * (or a Kubernetes compute). Changes to the model, code, environment, or
 * settings roll out in place; the endpoint's `traffic` decides which
 * deployments receive requests.
 *
 * Managed deployments bill per instance-hour from creation and need VM
 * quota for the instance type (plus a 20% upgrade buffer).
 *
 * @see https://learn.microsoft.com/azure/machine-learning/how-to-deploy-online-endpoints
 *
 * ### Deploying a Model
 * **Example:** MLflow model from the `azureml` registry
 * ```typescript
 * const endpoint = yield* Azure.MachineLearning.OnlineEndpoint("scoring", {
 *   resourceGroup: group.resourceGroupName,
 *   workspace: workspace.workspaceName,
 * });
 * const blue = yield* Azure.MachineLearning.OnlineDeployment("blue", {
 *   resourceGroup: group.resourceGroupName,
 *   workspace: workspace.workspaceName,
 *   endpoint: endpoint.endpointName,
 *   name: "blue",
 *   model: "azureml://registries/azureml/models/mlflow-model/versions/1",
 *   instanceType: "Standard_DS3_v2",
 *   instanceCount: 1,
 * });
 * ```
 *
 * ### Custom Scoring Code
 * **Example:** Model with a scoring script and environment
 * ```typescript
 * const green = yield* Azure.MachineLearning.OnlineDeployment("green", {
 *   resourceGroup: group.resourceGroupName,
 *   workspace: workspace.workspaceName,
 *   endpoint: endpoint.endpointName,
 *   model: modelAssetId,
 *   environmentId: environmentAssetId,
 *   codeConfiguration: { codeId: codeAssetId, scoringScript: "score.py" },
 *   instanceType: "Standard_DS3_v2",
 *   requestSettings: { requestTimeout: "PT10S" },
 * });
 * ```
 *
 * @resource
 */
export const OnlineDeployment = Resource<OnlineDeployment>(
  "Azure.MachineLearning.OnlineDeployment",
);

const getDeployment = (
  subscriptionId: string,
  resourceGroupName: string,
  workspaceName: string,
  endpointName: string,
  deploymentName: string,
) =>
  orUndefinedIfNotFound(
    ml.GetOnlineDeployment({
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
  deployment: ml.GetOnlineDeploymentResponse,
): OnlineDeployment["Attributes"] => ({
  deploymentName: name,
  deploymentId: deployment.id ?? "",
  endpoint,
  workspace,
  resourceGroup,
  location: deployment.location,
  endpointComputeType: deployment.properties.endpointComputeType,
  instanceType: deployment.properties.instanceType,
  instanceCount: deployment.sku?.capacity,
  tags: userTags(deployment.tags),
});

const desiredProperties = (news: OnlineDeploymentProps) => ({
  endpointComputeType: news.endpointComputeType ?? "Managed",
  instanceType: news.instanceType,
  model: news.model,
  environmentId: news.environmentId,
  codeConfiguration: news.codeConfiguration,
  environmentVariables: news.environmentVariables,
  requestSettings: news.requestSettings,
  livenessProbe: news.livenessProbe,
  readinessProbe: news.readinessProbe,
  appInsightsEnabled: news.appInsightsEnabled,
  egressPublicNetworkAccess: news.egressPublicNetworkAccess,
  description: news.description,
});

export const OnlineDeploymentProvider = () =>
  Provider.succeed(OnlineDeployment, {
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
          !sameArm(news.location, output.location)) ||
        !sameArm(
          news.endpointComputeType ?? "Managed",
          output.endpointComputeType,
        ) ||
        (news.instanceType !== undefined &&
          !sameArm(news.instanceType, output.instanceType))
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
      const instanceCount = news.instanceCount ?? 1;
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
      // Managed deployments pull the image and start instances: 10-20 min.
      const waitReady = waitForProvisioned(
        `machine learning online deployment ${name}`,
        get,
        (deployment) => deployment.properties.provisioningState,
        { interval: "10 seconds", times: 150 },
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
          (yield* ml.GetOnlineEndpoint({
            subscriptionId,
            resourceGroupName: resourceGroup,
            workspaceName: workspace,
            endpointName: endpoint,
          })).location;
        yield* ml.OnlineDeploymentsCreateOrUpdate({
          ...where,
          location,
          tags,
          sku: { name: "Default", capacity: instanceCount },
          properties,
        });
        observed = yield* waitReady;
      }

      // Sync scale and tags (PATCH).
      if (
        observed.sku?.capacity !== instanceCount ||
        tagsDiffer(observed.tags, tags)
      ) {
        yield* ml.UpdateOnlineDeployment({
          ...where,
          tags,
          sku: { name: "Default", capacity: instanceCount },
        });
        observed = yield* waitForProvisioned(
          `machine learning online deployment ${name}`,
          get,
          (deployment) => {
            const state = deployment.properties.provisioningState;
            if (state !== undefined && state !== "Succeeded") return state;
            return deployment.sku?.capacity === instanceCount &&
              !tagsDiffer(deployment.tags, tags)
              ? "Succeeded"
              : "Updating";
          },
          { interval: "10 seconds", times: 90 },
        );
      }

      return toAttrs(resourceGroup, workspace, endpoint, name, observed);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        ml.DeleteOnlineDeployment({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          workspaceName: output.workspace,
          endpointName: output.endpoint,
          deploymentName: output.deploymentName,
        }),
      );
      yield* waitUntilGone(
        `machine learning online deployment ${output.deploymentName}`,
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

    nuke: { dependsOn: ["Azure.MachineLearning.OnlineEndpoint"] },
  });
