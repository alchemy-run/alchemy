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
  registryPath,
} from "./internal.ts";

export interface ComponentContainerProps extends Omit<
  AssetContainerProps,
  "workspace" | "registry"
> {
  /**
   * Registry that owns the component. Workspace component containers
   * accept neither tags nor a description and cannot be deleted, so
   * component containers are managed only in registries; in a workspace,
   * declare only a {@link ComponentVersion}. Changing it replaces the
   * component.
   */
  registry: string;
}

export interface ComponentContainer extends Resource<
  "Azure.MachineLearning.ComponentContainer",
  ComponentContainerProps,
  AssetContainerAttributes,
  never,
  Providers
> {}

/**
 * A component in an Azure Machine Learning registry
 * (`Microsoft.MachineLearningServices/registries/components`) — the named container that groups the versions of a reusable pipeline step shared across workspaces.
 * Register versions with {@link ComponentVersion}.
 *
 * See the [Azure documentation](https://learn.microsoft.com/azure/machine-learning/how-to-share-models-pipelines-across-workspaces-with-registries).
 *
 * Workspace component containers (`workspaces/components`)
 * reject tags and descriptions and cannot be deleted; Azure creates them
 * when you register a {@link ComponentVersion} in a workspace.
 *
 * Description, properties, tags, and the archive flag update in place.
 *
 * :::caution
 * Changing `resourceGroup`, `registry`, or `name` replaces the component.
 * :::
 *
 * ### Creating a Shared Component
 * **Example:** Component in a registry
 * ```typescript
 * const registry = yield* Azure.MachineLearning.Registry("shared");
 * const shared = yield* Azure.MachineLearning.ComponentContainer("prep", {
 *   registry: registry.registryName,
 *   description: "Data preparation step",
 *   tags: { team: "ml" },
 * });
 * ```
 *
 * @resource
 */
export const ComponentContainer = GroupedResource<ComponentContainer>(
  "Azure.MachineLearning.ComponentContainer",
);

const ops: ContainerOps = {
  get: (s) => ml.GetRegistryComponentContainer({ ...registryPath(s), componentName: s.name }),
  put: (s, body) =>
    ml.RegistryComponentContainersCreateOrUpdate({
      ...registryPath(s),
      componentName: s.name,
      properties: body,
    }),
  delete: (s) => ml.DeleteRegistryComponentContainer({ ...registryPath(s), componentName: s.name }),
};

export const ComponentContainerProvider = () =>
  Provider.succeed(
    ComponentContainer,
    containerProvider("component container", ops, { registryOnly: true }),
  );
