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

export interface ComponentVersionProps extends AssetVersionProps {
  /**
   * Component definition in the YAML schema's JSON form (`$schema`,
   * `name`, `version`, `type`, `command`, `environment`, `inputs`,
   * `outputs`, ...). Changing it replaces the version.
   * @see https://learn.microsoft.com/azure/machine-learning/reference-yaml-component-command
   */
  componentSpec: Record<string, unknown>;
}

export interface ComponentVersion extends Resource<
  "Azure.MachineLearning.ComponentVersion",
  ComponentVersionProps,
  AssetVersionAttributes,
  never,
  Providers
> {}

/**
 * A component version in an Azure Machine Learning workspace or registry
 * (`Microsoft.MachineLearningServices/workspaces/components/versions` or
 * `registries/components/versions`) — an immutable definition of a reusable
 * pipeline step (command, inputs, outputs, environment). Azure creates the
 * {@link ComponentContainer} named by `name` if it does not exist; in a
 * registry, declare one to manage its description and tags (workspace
 * containers accept neither).
 *
 * Versions are immutable: only the description, tags, and archive flag
 * update in place.
 *
 * Azure does not delete component versions in a workspace, so destroying the
 * resource archives the version; deleting the workspace removes it. Because
 * an archived version keeps its name, change `version` (not only the spec)
 * to register a new definition in a workspace. Registry component versions
 * are deleted.
 *
 * :::caution
 * Changing `resourceGroup`, `workspace`, `registry`, `name`, `version`, or
 * any content prop replaces the version. When `name` and `version` stay the
 * same, the old version is deleted before the new one is created.
 * :::
 *
 * @see https://learn.microsoft.com/azure/machine-learning/reference-yaml-component-command
 *
 * ### Registering a Component version
 * **Example:** Component version in a workspace
 * ```typescript
 * const prep = yield* Azure.MachineLearning.ComponentVersion("prep-v1", {
 *   workspace: workspace.workspaceName,
 *   name: "prep",
 *   version: "1",
 *   componentSpec: {
 *     $schema: "https://azuremlschemas.azureedge.net/latest/commandComponent.schema.json",
 *     name: "prep",
 *     version: "1",
 *     type: "command",
 *     command: "echo hello",
 *     environment: "azureml://registries/azureml/environments/sklearn-1.5/labels/latest",
 *   },
 * });
 * ```
 *
 * **Example:** Component version in a registry
 * ```typescript
 * const shared = yield* Azure.MachineLearning.ComponentVersion("shared-prep-v1", {
 *   registry: registry.registryName,
 *   name: "prep",
 *   version: "1",
 *   componentSpec: {
 *     $schema: "https://azuremlschemas.azureedge.net/latest/commandComponent.schema.json",
 *     name: "prep",
 *     version: "1",
 *     type: "command",
 *     command: "echo hello",
 *     environment: "azureml://registries/azureml/environments/sklearn-1.5/labels/latest",
 *   },
 * });
 * ```
 *
 * @resource
 */
export const ComponentVersion = GroupedResource<ComponentVersion>(
  "Azure.MachineLearning.ComponentVersion",
);

const ops: VersionOps<ComponentVersionProps> = {
  get: (s) =>
    s.registryName !== undefined
      ? ml.GetRegistryComponentVersion({
          subscriptionId: s.subscriptionId,
          resourceGroupName: s.resourceGroupName,
          registryName: s.registryName,
          componentName: s.name,
          version: s.version,
        })
      : ml.GetComponentVersion({
          subscriptionId: s.subscriptionId,
          resourceGroupName: s.resourceGroupName,
          workspaceName: s.workspaceName,
          name: s.name,
          version: s.version,
        }),
  put: (s, body, news) =>
    s.registryName !== undefined
      ? ml.RegistryComponentVersionsCreateOrUpdate({
          subscriptionId: s.subscriptionId,
          resourceGroupName: s.resourceGroupName,
          registryName: s.registryName,
          componentName: s.name,
          version: s.version,
          properties: {
            ...body,
            componentSpec: news.componentSpec,
          },
        })
      : ml.ComponentVersionsCreateOrUpdate({
          subscriptionId: s.subscriptionId,
          resourceGroupName: s.resourceGroupName,
          workspaceName: s.workspaceName,
          name: s.name,
          version: s.version,
          properties: {
            ...body,
            componentSpec: news.componentSpec,
          },
        }),
  delete: (s) =>
    s.registryName !== undefined
      ? ml.DeleteRegistryComponentVersion({
          subscriptionId: s.subscriptionId,
          resourceGroupName: s.resourceGroupName,
          registryName: s.registryName,
          componentName: s.name,
          version: s.version,
        })
      : ml.DeleteComponentVersion({
          subscriptionId: s.subscriptionId,
          resourceGroupName: s.resourceGroupName,
          workspaceName: s.workspaceName,
          name: s.name,
          version: s.version,
        }),
};

export const ComponentVersionProvider = () =>
  Provider.succeed(
    ComponentVersion,
    versionProvider("component version", ops, { archiveInWorkspace: true }),
  );
