import * as ml from "@distilled.cloud/azure/machinelearningservices";
import * as Provider from "alchemy/Provider";
import type { Resource } from "alchemy/Resource";
import type { Providers } from "../Providers.ts";
import { GroupedResource } from "../StackResourceGroup.ts";
import {
  versionProvider,
  type AssetVersionAttributes,
  type AssetVersionProps,
  type VersionOps,
} from "./internal.ts";

export interface ModelVersionProps extends AssetVersionProps {
  /**
   * URI of the model files: an `https://`, `azureml://datastores/...`, or
   * `azureml://jobs/<job>/outputs/...` path. Changing it replaces the
   * version.
   */
  modelUri?: string;
  /**
   * Storage format of the model (`custom_model`, `mlflow_model`,
   * `triton_model`). Changing it replaces the version.
   * @default Azure's default (`custom_model`)
   */
  modelType?: string;
  /**
   * Model flavors and their flavor-specific data (MLflow). Changing them
   * replaces the version.
   */
  flavors?: Record<string, { data?: Record<string, string> }>;
  /** Name of the training job that produced the model. Changing it replaces the version. */
  jobName?: string;
  /** Lifecycle stage label of the version (e.g. `Production`). */
  stage?: string;
}

export interface ModelVersion extends Resource<
  "Azure.MachineLearning.ModelVersion",
  ModelVersionProps,
  AssetVersionAttributes,
  never,
  Providers
> {}

/**
 * A model version in an Azure Machine Learning workspace or registry
 * (`Microsoft.MachineLearningServices/workspaces/models/versions` or
 * `registries/models/versions`) — an immutable registration of trained model
 * files that online and batch deployments serve. Azure creates the {@link ModelContainer} named by `name` if it does not exist; declare one to
 * manage its description and tags.
 *
 * Versions are immutable: only the description, tags, archive flag, and
 * stage update in place.
 *
 * :::caution
 * Changing `resourceGroup`, `workspace`, `registry`, `name`, `version`, or
 * any content prop replaces the version. When `name` and `version` stay the
 * same, the old version is deleted before the new one is created.
 * :::
 *
 * @see https://learn.microsoft.com/azure/machine-learning/how-to-manage-models
 *
 * ### Registering a Model version
 * **Example:** Model version in a workspace
 * ```typescript
 * const churn = yield* Azure.MachineLearning.ModelVersion("churn-v1", {
 *   workspace: workspace.workspaceName,
 *   name: "churn",
 *   version: "1",
 *   modelType: "custom_model",
 *   modelUri: "azureml://datastores/workspaceblobstore/paths/models/churn",
 * });
 * ```
 *
 * **Example:** Model version in a registry
 * ```typescript
 * const shared = yield* Azure.MachineLearning.ModelVersion("shared-churn-v1", {
 *   registry: registry.registryName,
 *   name: "churn",
 *   version: "1",
 *   modelType: "custom_model",
 *   modelUri: "azureml://datastores/workspaceblobstore/paths/models/churn",
 * });
 * ```
 *
 * @resource
 */
export const ModelVersion = GroupedResource<ModelVersion>("Azure.MachineLearning.ModelVersion");

const ops: VersionOps<ModelVersionProps> = {
  get: (s) =>
    s.registryName !== undefined
      ? ml.GetRegistryModelVersion({
          subscriptionId: s.subscriptionId,
          resourceGroupName: s.resourceGroupName,
          registryName: s.registryName,
          modelName: s.name,
          version: s.version,
        })
      : ml.GetModelVersion({
          subscriptionId: s.subscriptionId,
          resourceGroupName: s.resourceGroupName,
          workspaceName: s.workspaceName,
          name: s.name,
          version: s.version,
        }),
  put: (s, body, news) =>
    s.registryName !== undefined
      ? ml.RegistryModelVersionsCreateOrUpdate({
          subscriptionId: s.subscriptionId,
          resourceGroupName: s.resourceGroupName,
          registryName: s.registryName,
          modelName: s.name,
          version: s.version,
          properties: {
            ...body,
            modelUri: news.modelUri,
            modelType: news.modelType,
            flavors: news.flavors,
            jobName: news.jobName,
          },
        })
      : ml.ModelVersionsCreateOrUpdate({
          subscriptionId: s.subscriptionId,
          resourceGroupName: s.resourceGroupName,
          workspaceName: s.workspaceName,
          name: s.name,
          version: s.version,
          properties: {
            ...body,
            modelUri: news.modelUri,
            modelType: news.modelType,
            flavors: news.flavors,
            jobName: news.jobName,
          },
        }),
  delete: (s) =>
    s.registryName !== undefined
      ? ml.DeleteRegistryModelVersion({
          subscriptionId: s.subscriptionId,
          resourceGroupName: s.resourceGroupName,
          registryName: s.registryName,
          modelName: s.name,
          version: s.version,
        })
      : ml.DeleteModelVersion({
          subscriptionId: s.subscriptionId,
          resourceGroupName: s.resourceGroupName,
          workspaceName: s.workspaceName,
          name: s.name,
          version: s.version,
        }),
  stageOf: (news) => news.stage,
};

export const ModelVersionProvider = () =>
  Provider.succeed(ModelVersion, versionProvider("model version", ops));
