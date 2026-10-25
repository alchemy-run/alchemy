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

export interface CodeContainerProps extends Omit<AssetContainerProps, "workspace" | "registry"> {
  /**
   * Registry that owns the code asset. Workspaces keep code versions
   * without an addressable container, so code containers exist only in
   * registries. Changing it replaces the code asset.
   */
  registry: string;
}

export interface CodeContainer extends Resource<
  "Azure.MachineLearning.CodeContainer",
  CodeContainerProps,
  AssetContainerAttributes,
  never,
  Providers
> {}

/**
 * A code asset in an Azure Machine Learning registry
 * (`Microsoft.MachineLearningServices/registries/codes`) — the named
 * container that groups the versions of a job's or component's source
 * snapshot shared across workspaces. Register versions with
 * {@link CodeVersion}.
 *
 * See the [Azure documentation](https://learn.microsoft.com/azure/machine-learning/how-to-share-models-pipelines-across-workspaces-with-registries).
 *
 * Workspaces keep code versions without an addressable container (Azure
 * rejects `workspaces/codes` reads), so declare only a {@link CodeVersion}
 * there.
 *
 * Description, properties, tags, and the archive flag update in place.
 *
 * :::caution
 * Changing `resourceGroup`, `registry`, or `name` replaces the code asset.
 * :::
 *
 * ### Creating a Code Asset
 * **Example:** Code asset shared through a registry
 * ```typescript
 * const registry = yield* Azure.MachineLearning.Registry("shared");
 * const code = yield* Azure.MachineLearning.CodeContainer("trainer", {
 *   registry: registry.registryName,
 *   description: "Training scripts",
 *   tags: { team: "ml" },
 * });
 * ```
 *
 * @resource
 */
export const CodeContainer = GroupedResource<CodeContainer>("Azure.MachineLearning.CodeContainer");

const ops: ContainerOps = {
  get: (s) => ml.GetRegistryCodeContainer({ ...registryPath(s), codeName: s.name }),
  put: (s, body) =>
    ml.RegistryCodeContainersCreateOrUpdate({
      ...registryPath(s),
      codeName: s.name,
      properties: body,
    }),
  delete: (s) => ml.DeleteRegistryCodeContainer({ ...registryPath(s), codeName: s.name }),
};

export const CodeContainerProvider = () =>
  Provider.succeed(CodeContainer, containerProvider("code container", ops, { registryOnly: true }));
