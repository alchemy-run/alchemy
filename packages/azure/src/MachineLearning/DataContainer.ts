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

export interface DataContainerProps extends AssetContainerProps {
  /**
   * Kind of data the asset's versions hold. Changing it replaces the data
   * asset.
   * @default "uri_folder"
   */
  dataType?: "uri_file" | "uri_folder" | "mltable";
}

export interface DataContainer extends Resource<
  "Azure.MachineLearning.DataContainer",
  DataContainerProps,
  AssetContainerAttributes,
  never,
  Providers
> {}

/**
 * A data asset in an Azure Machine Learning workspace or registry
 * (`Microsoft.MachineLearningServices/workspaces/data` or `registries/data`)
 * — the named container that groups the versions of a file, folder, or
 * MLTable that jobs consume. Register versions with {@link DataVersion}.
 *
 * See the [Azure documentation](https://learn.microsoft.com/azure/machine-learning/concept-data).
 *
 * Description, properties, tags, and the archive flag update in place.
 *
 * :::caution
 * Changing `dataType` replaces the data asset.
 * :::
 *
 * Azure does not delete data assets in a workspace, so destroying the
 * resource archives it; deleting the workspace removes it. Registry data
 * assets are deleted.
 *
 * :::caution
 * Changing `resourceGroup`, `workspace`, `registry`, or `name` replaces the
 * data asset.
 * :::
 *
 * ### Creating a Data asset
 * **Example:** Data asset in a workspace
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
 * const dataContainer = yield* Azure.MachineLearning.DataContainer("taxi-trips", {
 *   workspace: workspace.workspaceName,
 *   description: "NYC taxi trips",
 *   tags: { team: "ml" },
 * });
 * ```
 *
 * **Example:** Data asset shared through a registry
 * ```typescript
 * const shared = yield* Azure.MachineLearning.DataContainer("shared-taxi-trips", {
 *   registry: registry.registryName,
 * });
 * ```
 *
 * @resource
 */
export const DataContainer = GroupedResource<DataContainer>("Azure.MachineLearning.DataContainer");

const ops: ContainerOps<DataContainerProps> = {
  get: (s) =>
    s.registryName !== undefined
      ? ml.GetRegistryDataContainer({
          subscriptionId: s.subscriptionId,
          resourceGroupName: s.resourceGroupName,
          registryName: s.registryName,
          name: s.name,
        })
      : ml.GetDataContainer({
          subscriptionId: s.subscriptionId,
          resourceGroupName: s.resourceGroupName,
          workspaceName: s.workspaceName,
          name: s.name,
        }),
  put: (s, body, news) =>
    s.registryName !== undefined
      ? ml.RegistryDataContainersCreateOrUpdate({
          subscriptionId: s.subscriptionId,
          resourceGroupName: s.resourceGroupName,
          registryName: s.registryName,
          name: s.name,
          properties: { ...body, dataType: news.dataType ?? "uri_folder" },
        })
      : ml.DataContainersCreateOrUpdate({
          subscriptionId: s.subscriptionId,
          resourceGroupName: s.resourceGroupName,
          workspaceName: s.workspaceName,
          name: s.name,
          properties: { ...body, dataType: news.dataType ?? "uri_folder" },
        }),
  delete: (s) =>
    s.registryName !== undefined
      ? ml.DeleteRegistryDataContainer({
          subscriptionId: s.subscriptionId,
          resourceGroupName: s.resourceGroupName,
          registryName: s.registryName,
          name: s.name,
        })
      : ml.DeleteDataContainer({
          subscriptionId: s.subscriptionId,
          resourceGroupName: s.resourceGroupName,
          workspaceName: s.workspaceName,
          name: s.name,
        }),
};

export const DataContainerProvider = () =>
  Provider.succeed(
    DataContainer,
    containerProvider("data container", ops, {
      archiveInWorkspace: true,
      immutableProps: ["dataType"],
    }),
  );
