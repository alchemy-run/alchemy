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

export interface EnvironmentRoute {
  /** Route path, e.g. `/score`. */
  path: string;
  /** Container port. */
  port: number;
}

export interface EnvironmentInferenceConfig {
  /** Route that reports the inference server is alive. */
  livenessRoute?: EnvironmentRoute;
  /** Route that reports the inference server is ready. */
  readinessRoute?: EnvironmentRoute;
  /** Route that serves scoring requests. */
  scoringRoute?: EnvironmentRoute;
}

export interface EnvironmentBuildContext {
  /** URI of the Docker build context (a blob folder). */
  contextUri: string;
  /**
   * Path to the Dockerfile inside the build context.
   * @default "Dockerfile"
   */
  dockerfilePath?: string;
}

export interface EnvironmentVersionProps extends AssetVersionProps {
  /**
   * Base image, e.g. `mcr.microsoft.com/azureml/openmpi4.1.0-ubuntu22.04`.
   * Set `image` or `build`. Changing it replaces the version.
   * @default none
   */
  image?: string;
  /**
   * Docker build context Azure builds the image from. Set `image` or
   * `build`. Changing it replaces the version.
   * @default none
   */
  build?: EnvironmentBuildContext;
  /**
   * Conda environment specification (the YAML text) installed on top of
   * `image`. Changing it replaces the version.
   * @default none
   */
  condaFile?: string;
  /**
   * Operating system of the image. Changing it replaces the version.
   * @default "Linux"
   */
  osType?: "Linux" | "Windows";
  /**
   * Rebuild the derived image when the base image updates. Changing it
   * replaces the version.
   * @default "Disabled"
   */
  autoRebuild?: "Disabled" | "OnBaseImageUpdate";
  /**
   * Routes of an inference server image. Changing them replaces the
   * version.
   * @default none
   */
  inferenceConfig?: EnvironmentInferenceConfig;
  /**
   * Lifecycle stage label of the version (e.g. `Development`).
   * @default none
   */
  stage?: string;
}

export interface EnvironmentVersion extends Resource<
  "Azure.MachineLearning.EnvironmentVersion",
  EnvironmentVersionProps,
  AssetVersionAttributes,
  never,
  Providers
> {}

/**
 * An environment version in an Azure Machine Learning workspace or registry
 * (`Microsoft.MachineLearningServices/workspaces/environments/versions` or
 * `registries/environments/versions`) — an immutable Docker image (or Docker
 * build context) plus an optional Conda specification that jobs and
 * deployments run in. Azure creates the {@link EnvironmentContainer} named
 * by `name` if it does not exist; in a registry, declare one to manage its
 * description and tags (workspace containers accept neither).
 *
 * See the [Azure documentation](https://learn.microsoft.com/azure/machine-learning/concept-environments).
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
 * ### Registering a Environment version
 * **Example:** Environment version in a workspace
 * ```typescript
 * // An existing Application Insights component for workspace telemetry.
 * const insightsId =
 *   "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/monitoring/providers/Microsoft.Insights/components/ml-insights";
 * const storage = yield* Azure.Storage.StorageAccount("artifacts");
 * const vault = yield* Azure.KeyVault.Vault("secrets", { enableRbacAuthorization: false });
 * const workspace = yield* Azure.MachineLearning.Workspace("ml", {
 *   storageAccount: storage.storageAccountId,
 *   keyVault: vault.vaultId,
 *   applicationInsights: insightsId,
 * });
 * const sklearn = yield* Azure.MachineLearning.EnvironmentVersion("sklearn-v1", {
 *   workspace: workspace.workspaceName,
 *   name: "sklearn",
 *   version: "1",
 *   image: "mcr.microsoft.com/azureml/openmpi4.1.0-ubuntu22.04",
 *   condaFile: [
 *     "name: sklearn",
 *     "dependencies:",
 *     "  - python=3.11",
 *     "  - scikit-learn",
 *   ].join("\n"),
 * });
 * ```
 *
 * **Example:** Environment version in a registry
 * ```typescript
 * const shared = yield* Azure.MachineLearning.EnvironmentVersion("shared-sklearn-v1", {
 *   registry: registry.registryName,
 *   name: "sklearn",
 *   version: "1",
 *   image: "mcr.microsoft.com/azureml/openmpi4.1.0-ubuntu22.04",
 *   condaFile: [
 *     "name: sklearn",
 *     "dependencies:",
 *     "  - python=3.11",
 *     "  - scikit-learn",
 *   ].join("\n"),
 * });
 * ```
 *
 * @resource
 */
export const EnvironmentVersion = GroupedResource<EnvironmentVersion>(
  "Azure.MachineLearning.EnvironmentVersion",
);

const ops: VersionOps<EnvironmentVersionProps> = {
  get: (s) =>
    s.registryName !== undefined
      ? ml.GetRegistryEnvironmentVersion({
          subscriptionId: s.subscriptionId,
          resourceGroupName: s.resourceGroupName,
          registryName: s.registryName,
          environmentName: s.name,
          version: s.version,
        })
      : ml.GetEnvironmentVersion({
          subscriptionId: s.subscriptionId,
          resourceGroupName: s.resourceGroupName,
          workspaceName: s.workspaceName,
          name: s.name,
          version: s.version,
        }),
  put: (s, body, news) =>
    s.registryName !== undefined
      ? ml.RegistryEnvironmentVersionsCreateOrUpdate({
          subscriptionId: s.subscriptionId,
          resourceGroupName: s.resourceGroupName,
          registryName: s.registryName,
          environmentName: s.name,
          version: s.version,
          properties: {
            ...body,
            image: news.image,
            build: news.build,
            condaFile: news.condaFile,
            osType: news.osType,
            autoRebuild: news.autoRebuild,
            inferenceConfig: news.inferenceConfig,
          },
        })
      : ml.EnvironmentVersionsCreateOrUpdate({
          subscriptionId: s.subscriptionId,
          resourceGroupName: s.resourceGroupName,
          workspaceName: s.workspaceName,
          name: s.name,
          version: s.version,
          properties: {
            ...body,
            image: news.image,
            build: news.build,
            condaFile: news.condaFile,
            osType: news.osType,
            autoRebuild: news.autoRebuild,
            inferenceConfig: news.inferenceConfig,
          },
        }),
  delete: (s) =>
    s.registryName !== undefined
      ? ml.DeleteRegistryEnvironmentVersion({
          subscriptionId: s.subscriptionId,
          resourceGroupName: s.resourceGroupName,
          registryName: s.registryName,
          environmentName: s.name,
          version: s.version,
        })
      : ml.DeleteEnvironmentVersion({
          subscriptionId: s.subscriptionId,
          resourceGroupName: s.resourceGroupName,
          workspaceName: s.workspaceName,
          name: s.name,
          version: s.version,
        }),
  stageOf: (news) => news.stage,
};

export const EnvironmentVersionProvider = () =>
  Provider.succeed(EnvironmentVersion, versionProvider("environment version", ops));
