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
 * Azure rejects tags, a description, and properties on feature set
 * containers ("Tags are not supported.") and ignores the archive flag.
 */
export type FeaturesetContainerProps = Omit<
  AssetContainerProps,
  "tags" | "description" | "properties" | "isArchived"
>;

export interface FeaturesetContainer extends Resource<
  "Azure.MachineLearning.FeaturesetContainer",
  FeaturesetContainerProps,
  AssetContainerAttributes,
  never,
  Providers
> {}

/**
 * A feature set in an Azure Machine Learning workspace
 * (`Microsoft.MachineLearningServices/workspaces/featuresets`) — the named
 * container that groups the versions of a feature set in a `FeatureStore`
 * workspace. Register versions with {@link FeaturesetVersion}.
 *
 * See the [Azure documentation](https://learn.microsoft.com/azure/machine-learning/concept-what-is-managed-feature-store).
 *
 * The container has nothing mutable: Azure rejects tags, a description,
 * and properties on it and ignores the archive flag. The feature store
 * workspace's stack/stage tags mark Alchemy ownership. Feature store
 * assets live only in `FeatureStore` workspaces.
 *
 * :::caution
 * Changing `resourceGroup`, `workspace`, or `name` replaces the feature set.
 * :::
 *
 * ### Creating a Feature set
 * **Example:** Feature set in a workspace
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
 * const featuresetContainer = yield* Azure.MachineLearning.FeaturesetContainer("transactions", {
 *   workspace: featureStore.workspaceName,
 * });
 * ```
 *
 * @resource
 */
export const FeaturesetContainer = GroupedResource<FeaturesetContainer>(
  "Azure.MachineLearning.FeaturesetContainer",
);

const ops: ContainerOps = {
  get: (s) => ml.GetFeaturesetContainerEntity(workspacePath(s)),
  put: (s, body) =>
    ml.FeaturesetContainersCreateOrUpdate({ ...workspacePath(s), properties: body }),
  delete: (s) => ml.DeleteFeaturesetContainer(workspacePath(s)),
};

export const FeaturesetContainerProvider = () =>
  Provider.succeed(
    FeaturesetContainer,
    containerProvider("feature set container", ops, {
      workspaceOnly: true,
      untaggedInWorkspace: true,
    }),
  );
