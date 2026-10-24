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

export type DataVersionType = "uri_file" | "uri_folder" | "mltable";

export interface DataVersionProps extends AssetVersionProps {
  /**
   * Kind of data the URI points at. Changing it replaces the version.
   * @default "uri_folder"
   */
  dataType?: DataVersionType;
  /**
   * URI of the data: an `https://`, `azureml://datastores/...`, `wasbs://`,
   * or `abfss://` path. Changing it replaces the version.
   */
  dataUri: string;
}

export interface DataVersion extends Resource<
  "Azure.MachineLearning.DataVersion",
  DataVersionProps,
  AssetVersionAttributes,
  never,
  Providers
> {}

/**
 * A data version in an Azure Machine Learning workspace or registry
 * (`Microsoft.MachineLearningServices/workspaces/data/versions` or
 * `registries/data/versions`) — an immutable reference to a file, folder, or
 * MLTable that jobs consume. Azure creates the {@link DataContainer} named
 * by `name` if it does not exist; declare one to manage its description and
 * tags.
 *
 * Versions are immutable: only the description, tags, and archive flag
 * update in place.
 *
 * Azure does not delete data versions in a workspace, so destroying the
 * resource archives the version; deleting the workspace removes it. Because
 * an archived version keeps its name, change `version` (not only the
 * content) to register new data in a workspace. Registry data versions are
 * deleted.
 *
 * :::caution
 * Changing `resourceGroup`, `workspace`, `registry`, `name`, `version`, or
 * any content prop replaces the version. When `name` and `version` stay the
 * same, the old version is deleted before the new one is created.
 * :::
 *
 * @see https://learn.microsoft.com/azure/machine-learning/how-to-create-data-assets
 *
 * ### Registering a Data version
 * **Example:** Data version in a workspace
 * ```typescript
 * const trips = yield* Azure.MachineLearning.DataVersion("trips-v1", {
 *   workspace: workspace.workspaceName,
 *   name: "taxi-trips",
 *   version: "1",
 *   dataType: "uri_file",
 *   dataUri: "azureml://datastores/workspaceblobstore/paths/data/trips.csv",
 * });
 * ```
 *
 * **Example:** Data version in a registry
 * ```typescript
 * const shared = yield* Azure.MachineLearning.DataVersion("shared-trips-v1", {
 *   registry: registry.registryName,
 *   name: "taxi-trips",
 *   version: "1",
 *   dataType: "uri_file",
 *   dataUri: "azureml://datastores/workspaceblobstore/paths/data/trips.csv",
 * });
 * ```
 *
 * @resource
 */
export const DataVersion = GroupedResource<DataVersion>("Azure.MachineLearning.DataVersion");

const ops: VersionOps<DataVersionProps> = {
  get: (s) =>
    s.registryName !== undefined
      ? ml.GetRegistryDataVersion({
          subscriptionId: s.subscriptionId,
          resourceGroupName: s.resourceGroupName,
          registryName: s.registryName,
          name: s.name,
          version: s.version,
        })
      : ml.GetDataVersion({
          subscriptionId: s.subscriptionId,
          resourceGroupName: s.resourceGroupName,
          workspaceName: s.workspaceName,
          name: s.name,
          version: s.version,
        }),
  put: (s, body, news) =>
    s.registryName !== undefined
      ? ml.RegistryDataVersionsCreateOrUpdate({
          subscriptionId: s.subscriptionId,
          resourceGroupName: s.resourceGroupName,
          registryName: s.registryName,
          name: s.name,
          version: s.version,
          properties: {
            ...body,
            dataType: news.dataType ?? "uri_folder",
            dataUri: news.dataUri,
          },
        })
      : ml.DataVersionsCreateOrUpdate({
          subscriptionId: s.subscriptionId,
          resourceGroupName: s.resourceGroupName,
          workspaceName: s.workspaceName,
          name: s.name,
          version: s.version,
          properties: {
            ...body,
            dataType: news.dataType ?? "uri_folder",
            dataUri: news.dataUri,
          },
        }),
  delete: (s) =>
    s.registryName !== undefined
      ? ml.DeleteRegistryDataVersion({
          subscriptionId: s.subscriptionId,
          resourceGroupName: s.resourceGroupName,
          registryName: s.registryName,
          name: s.name,
          version: s.version,
        })
      : ml.DeleteDataVersion({
          subscriptionId: s.subscriptionId,
          resourceGroupName: s.resourceGroupName,
          workspaceName: s.workspaceName,
          name: s.name,
          version: s.version,
        }),
};

export const DataVersionProvider = () =>
  Provider.succeed(DataVersion, versionProvider("data version", ops, { archiveInWorkspace: true }));
