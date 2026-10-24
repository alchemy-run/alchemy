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

export interface CodeVersionProps extends AssetVersionProps {
  /**
   * URI of the uploaded code snapshot (a blob folder, e.g.
   * `https://<account>.blob.core.windows.net/<container>/<path>`). Changing it
   * replaces the version.
   */
  codeUri: string;
}

export interface CodeVersion extends Resource<
  "Azure.MachineLearning.CodeVersion",
  CodeVersionProps,
  AssetVersionAttributes,
  never,
  Providers
> {}

/**
 * A code version in an Azure Machine Learning workspace or registry
 * (`Microsoft.MachineLearningServices/workspaces/codes/versions` or
 * `registries/codes/versions`) — an immutable snapshot of source code,
 * stored in blob storage, that jobs and components run. Azure creates the
 * {@link CodeContainer} named by `name` if it does not exist; in a registry,
 * declare one to manage its description and tags (workspace containers
 * accept neither).
 *
 * Versions are immutable: only the description, tags, and archive flag
 * update in place.
 *
 * :::caution
 * Changing `resourceGroup`, `workspace`, `registry`, `name`, `version`, or
 * any content prop replaces the version. When `name` and `version` stay the
 * same, the old version is deleted before the new one is created.
 * :::
 *
 * @see https://learn.microsoft.com/azure/machine-learning/concept-component
 *
 * ### Registering a Code version
 * **Example:** Code version in a workspace
 * ```typescript
 * const code = yield* Azure.MachineLearning.CodeVersion("trainer-v1", {
 *   workspace: workspace.workspaceName,
 *   name: "trainer",
 *   version: "1",
 *   codeUri: `https://${storage.storageAccountName}.blob.core.windows.net/code/trainer`,
 * });
 * ```
 *
 * **Example:** Code version in a registry
 * ```typescript
 * const shared = yield* Azure.MachineLearning.CodeVersion("shared-trainer-v1", {
 *   registry: registry.registryName,
 *   name: "trainer",
 *   version: "1",
 *   codeUri: `https://${storage.storageAccountName}.blob.core.windows.net/code/trainer`,
 * });
 * ```
 *
 * @resource
 */
export const CodeVersion = GroupedResource<CodeVersion>("Azure.MachineLearning.CodeVersion");

const ops: VersionOps<CodeVersionProps> = {
  get: (s) =>
    s.registryName !== undefined
      ? ml.GetRegistryCodeVersion({
          subscriptionId: s.subscriptionId,
          resourceGroupName: s.resourceGroupName,
          registryName: s.registryName,
          codeName: s.name,
          version: s.version,
        })
      : ml.GetCodeVersion({
          subscriptionId: s.subscriptionId,
          resourceGroupName: s.resourceGroupName,
          workspaceName: s.workspaceName,
          name: s.name,
          version: s.version,
        }),
  put: (s, body, news) =>
    s.registryName !== undefined
      ? ml.RegistryCodeVersionsCreateOrUpdate({
          subscriptionId: s.subscriptionId,
          resourceGroupName: s.resourceGroupName,
          registryName: s.registryName,
          codeName: s.name,
          version: s.version,
          properties: {
            ...body,
            codeUri: news.codeUri,
          },
        })
      : ml.CodeVersionsCreateOrUpdate({
          subscriptionId: s.subscriptionId,
          resourceGroupName: s.resourceGroupName,
          workspaceName: s.workspaceName,
          name: s.name,
          version: s.version,
          properties: {
            ...body,
            codeUri: news.codeUri,
          },
        }),
  delete: (s) =>
    s.registryName !== undefined
      ? ml.DeleteRegistryCodeVersion({
          subscriptionId: s.subscriptionId,
          resourceGroupName: s.resourceGroupName,
          registryName: s.registryName,
          codeName: s.name,
          version: s.version,
        })
      : ml.DeleteCodeVersion({
          subscriptionId: s.subscriptionId,
          resourceGroupName: s.resourceGroupName,
          workspaceName: s.workspaceName,
          name: s.name,
          version: s.version,
        }),
};

export const CodeVersionProvider = () =>
  Provider.succeed(CodeVersion, versionProvider("code version", ops));
