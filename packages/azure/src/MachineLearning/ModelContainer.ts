import * as ml from "@distilled.cloud/azure/machinelearningservices";
import * as Provider from "alchemy/Provider";
import type { Resource } from "alchemy/Resource";
import type { Providers } from "../Providers.ts";
import { GroupedResource } from "../StackResourceGroup.ts";
import {
  containerProvider,
  type AssetContainerAttributes,
  type AssetContainerProps,
  type ContainerOps,
} from "./internal.ts";

export type ModelContainerProps = AssetContainerProps;

export interface ModelContainer extends Resource<
  "Azure.MachineLearning.ModelContainer",
  ModelContainerProps,
  AssetContainerAttributes,
  never,
  Providers
> {}

/**
 * A model in an Azure Machine Learning workspace or registry
 * (`Microsoft.MachineLearningServices/workspaces/models` or
 * `registries/models`) — the named container that groups the registered
 * versions of a trained model. Register versions with {@link ModelVersion}.
 *
 * Description, properties, tags, and the archive flag update in place.
 *
 * :::caution
 * Changing `resourceGroup`, `workspace`, `registry`, or `name` replaces the
 * model.
 * :::
 *
 * @see https://learn.microsoft.com/azure/machine-learning/concept-model-management-and-deployment
 *
 * ### Creating a Model
 * **Example:** Model in a workspace
 * ```typescript
 * const modelContainer = yield* Azure.MachineLearning.ModelContainer("churn", {
 *   workspace: workspace.workspaceName,
 *   description: "Churn classifier",
 *   tags: { team: "ml" },
 * });
 * ```
 *
 * **Example:** Model shared through a registry
 * ```typescript
 * const shared = yield* Azure.MachineLearning.ModelContainer("shared-churn", {
 *   registry: registry.registryName,
 * });
 * ```
 *
 * @resource
 */
export const ModelContainer = GroupedResource<ModelContainer>(
  "Azure.MachineLearning.ModelContainer",
);

const ops: ContainerOps = {
  get: (s) =>
    s.registryName !== undefined
      ? ml.GetRegistryModelContainer({
          subscriptionId: s.subscriptionId,
          resourceGroupName: s.resourceGroupName,
          registryName: s.registryName,
          modelName: s.name,
        })
      : ml.GetModelContainer({
          subscriptionId: s.subscriptionId,
          resourceGroupName: s.resourceGroupName,
          workspaceName: s.workspaceName,
          name: s.name,
        }),
  put: (s, body) =>
    s.registryName !== undefined
      ? ml.RegistryModelContainersCreateOrUpdate({
          subscriptionId: s.subscriptionId,
          resourceGroupName: s.resourceGroupName,
          registryName: s.registryName,
          modelName: s.name,
          properties: body,
        })
      : ml.ModelContainersCreateOrUpdate({
          subscriptionId: s.subscriptionId,
          resourceGroupName: s.resourceGroupName,
          workspaceName: s.workspaceName,
          name: s.name,
          properties: body,
        }),
  delete: (s) =>
    s.registryName !== undefined
      ? ml.DeleteRegistryModelContainer({
          subscriptionId: s.subscriptionId,
          resourceGroupName: s.resourceGroupName,
          registryName: s.registryName,
          modelName: s.name,
        })
      : ml.DeleteModelContainer({
          subscriptionId: s.subscriptionId,
          resourceGroupName: s.resourceGroupName,
          workspaceName: s.workspaceName,
          name: s.name,
        }),
};

export const ModelContainerProvider = () =>
  Provider.succeed(ModelContainer, containerProvider("model container", ops));
