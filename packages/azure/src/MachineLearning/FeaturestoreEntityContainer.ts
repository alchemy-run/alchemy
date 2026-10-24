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
  workspacePath,
} from "./internal.ts";

export type FeaturestoreEntityContainerProps = AssetContainerProps;

export interface FeaturestoreEntityContainer extends Resource<
  "Azure.MachineLearning.FeaturestoreEntityContainer",
  FeaturestoreEntityContainerProps,
  AssetContainerAttributes,
  never,
  Providers
> {}

/**
 * A feature store entity in an Azure Machine Learning workspace
 * (`Microsoft.MachineLearningServices/workspaces/featurestoreEntities`) —
 * the named container that groups the versions of an entity (the index
 * columns feature sets join on) in a `FeatureStore` workspace. Register
 * versions with {@link FeaturestoreEntityVersion}.
 *
 * Description, properties, tags, and the archive flag update in place.
 * Feature store assets live only in `FeatureStore` workspaces.
 *
 * :::caution
 * Changing `resourceGroup`, `workspace`, or `name` replaces the feature
 * store entity.
 * :::
 *
 * @see https://learn.microsoft.com/azure/machine-learning/concept-what-is-managed-feature-store
 *
 * ### Creating a Feature store entity
 * **Example:** Feature store entity in a workspace
 * ```typescript
 * const featurestoreEntityContainer = yield* Azure.MachineLearning.FeaturestoreEntityContainer("account", {
 *   workspace: featureStore.workspaceName,
 *   description: "Customer account",
 *   tags: { team: "ml" },
 * });
 * ```
 *
 * @resource
 */
export const FeaturestoreEntityContainer = GroupedResource<FeaturestoreEntityContainer>(
  "Azure.MachineLearning.FeaturestoreEntityContainer",
);

const ops: ContainerOps = {
  get: (s) => ml.GetFeaturestoreEntityContainerEntity(workspacePath(s)),
  put: (s, body) =>
    ml.FeaturestoreEntityContainersCreateOrUpdate({ ...workspacePath(s), properties: body }),
  delete: (s) => ml.DeleteFeaturestoreEntityContainer(workspacePath(s)),
};

export const FeaturestoreEntityContainerProvider = () =>
  Provider.succeed(
    FeaturestoreEntityContainer,
    containerProvider("feature store entity container", ops, { workspaceOnly: true }),
  );
