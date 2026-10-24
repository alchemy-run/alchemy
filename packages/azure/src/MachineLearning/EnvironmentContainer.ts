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

export interface EnvironmentContainerProps extends Omit<
  AssetContainerProps,
  "workspace" | "registry"
> {
  /**
   * Registry that owns the environment. Workspace environment containers
   * accept neither tags nor a description and cannot be deleted, so
   * environment containers are managed only in registries; in a workspace,
   * declare only a {@link EnvironmentVersion}. Changing it replaces the
   * environment.
   */
  registry: string;
}

export interface EnvironmentContainer extends Resource<
  "Azure.MachineLearning.EnvironmentContainer",
  EnvironmentContainerProps,
  AssetContainerAttributes,
  never,
  Providers
> {}

/**
 * An environment in an Azure Machine Learning registry
 * (`Microsoft.MachineLearningServices/registries/environments`) — the named container that groups the versions of a Docker image and Conda specification shared across workspaces.
 * Register versions with {@link EnvironmentVersion}.
 *
 * Workspace environment containers (`workspaces/environments`)
 * reject tags and descriptions and cannot be deleted; Azure creates them
 * when you register a {@link EnvironmentVersion} in a workspace.
 *
 * Description, properties, tags, and the archive flag update in place.
 *
 * :::caution
 * Changing `resourceGroup`, `registry`, or `name` replaces the environment.
 * :::
 *
 * @see https://learn.microsoft.com/azure/machine-learning/how-to-share-models-pipelines-across-workspaces-with-registries
 *
 * ### Creating a Shared Environment
 * **Example:** Environment in a registry
 * ```typescript
 * const shared = yield* Azure.MachineLearning.EnvironmentContainer("sklearn", {
 *   registry: registry.registryName,
 *   description: "scikit-learn runtime",
 *   tags: { team: "ml" },
 * });
 * ```
 *
 * @resource
 */
export const EnvironmentContainer = GroupedResource<EnvironmentContainer>(
  "Azure.MachineLearning.EnvironmentContainer",
);

const ops: ContainerOps = {
  get: (s) => ml.GetRegistryEnvironmentContainer({ ...registryPath(s), environmentName: s.name }),
  put: (s, body) =>
    ml.RegistryEnvironmentContainersCreateOrUpdate({
      ...registryPath(s),
      environmentName: s.name,
      properties: body,
    }),
  delete: (s) =>
    ml.DeleteRegistryEnvironmentContainer({ ...registryPath(s), environmentName: s.name }),
};

export const EnvironmentContainerProvider = () =>
  Provider.succeed(
    EnvironmentContainer,
    containerProvider("environment container", ops, { registryOnly: true }),
  );
