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

/**
 * Azure rejects tags, a description, and properties on feature store
 * entity containers ("Tags are not supported.") and ignores the archive
 * flag; set them on the versions.
 */
export type FeaturestoreEntityContainerProps = Omit<
  AssetContainerProps,
  "tags" | "description" | "properties" | "isArchived"
>;

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
 * See the [Azure documentation](https://learn.microsoft.com/azure/machine-learning/concept-what-is-managed-feature-store).
 *
 * The container has nothing mutable: Azure rejects tags, a description,
 * and properties on it and ignores the archive flag (set them on the
 * versions). The feature store workspace's stack/stage tags mark Alchemy
 * ownership.
 * Feature store assets live only in `FeatureStore` workspaces.
 *
 * :::caution
 * Changing `resourceGroup`, `workspace`, or `name` replaces the feature
 * store entity.
 * :::
 *
 * ### Creating a Feature store entity
 * **Example:** Feature store entity in a workspace
 * ```typescript
 * // An existing Application Insights component for workspace telemetry.
 * const insightsId =
 *   "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/monitoring/providers/Microsoft.Insights/components/ml-insights";
 * const storage = yield* Azure.Storage.StorageAccount("artifacts");
 * const vault = yield* Azure.KeyVault.Vault("secrets", { enableRbacAuthorization: false });
 * const featureStore = yield* Azure.MachineLearning.Workspace("featureStore", {
 *   kind: "FeatureStore",
 *   storageAccount: storage.storageAccountId,
 *   keyVault: vault.vaultId,
 *   applicationInsights: insightsId,
 * });
 * const featurestoreEntityContainer = yield* Azure.MachineLearning.FeaturestoreEntityContainer("account", {
 *   workspace: featureStore.workspaceName,
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
    containerProvider("feature store entity container", ops, {
      workspaceOnly: true,
      untaggedInWorkspace: true,
    }),
  );
