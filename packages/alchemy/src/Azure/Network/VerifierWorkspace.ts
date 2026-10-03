import * as network from "@distilled.cloud/azure/network";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { orUndefinedIfNotFound, userTags } from "../Arm.ts";
import type { Providers } from "../Providers.ts";
import { networkProvider } from "./generic.ts";
import { networkManagerChildName } from "./networkManagerShared.ts";

export interface VerifierWorkspaceProps {
  /** Resource group of the network manager. Changing it replaces the workspace. */
  resourceGroup: string;
  /** Name of the parent network manager. Changing it replaces the workspace. */
  networkManager: string;
  /**
   * Name of the workspace. If omitted, a unique name is generated from the
   * app, stage, and logical ID. Changing it replaces the workspace.
   */
  name?: string;
  /**
   * Azure location. Changing it replaces the workspace.
   * @default the `Azure.Location` layer, else the profile location, else `eastus`
   */
  location?: string;
  /** Description of the workspace. */
  description?: string;
  /** User tags. Alchemy ownership tags are merged in automatically. */
  tags?: Record<string, string>;
}

export interface VerifierWorkspace extends Resource<
  "Azure.Network.VerifierWorkspace",
  VerifierWorkspaceProps,
  {
    /** Name of the workspace. */
    workspaceName: string;
    /** ARM resource ID of the workspace. */
    workspaceId: string;
    /** Name of the parent network manager. */
    networkManager: string;
    /** Resource group of the network manager. */
    resourceGroup: string;
    /** Location of the workspace. */
    location: string;
    /** Description. */
    description: string | undefined;
    /** User tags (Alchemy ownership tags stripped). */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * A Virtual Network Verifier workspace in an Azure Virtual Network
 * Manager — holds {@link ReachabilityAnalysisIntent}s that check whether
 * traffic can flow between two resources. Workspaces are free; analysis
 * runs bill per run.
 *
 * @see https://learn.microsoft.com/azure/virtual-network-manager/concept-virtual-network-verifier
 *
 * ### Creating a Workspace
 * **Example:** Verifier workspace
 * ```typescript
 * const workspace = yield* Azure.Network.VerifierWorkspace("verify", {
 *   resourceGroup: group.resourceGroupName,
 *   networkManager: manager.networkManagerName,
 * });
 * ```
 *
 * @resource
 */
export const VerifierWorkspace = Resource<VerifierWorkspace>(
  "Azure.Network.VerifierWorkspace",
);

export const VerifierWorkspaceProvider = () =>
  Provider.succeed(
    VerifierWorkspace,
    networkProvider<VerifierWorkspace>()({
      label: "verifier workspace",
      nameAttr: "workspaceName",
      parents: ["networkManager"],
      tracked: true,
      physicalName: networkManagerChildName,
      get: (subscriptionId, path) =>
        orUndefinedIfNotFound(
          network.GetVerifierWorkspace({
            subscriptionId,
            resourceGroupName: path.resourceGroup,
            networkManagerName: path.networkManager!,
            workspaceName: path.name,
          }),
        ),
      body: (news, { location, tags }) => ({
        location,
        tags,
        properties: { description: news.description },
      }),
      put: (subscriptionId, path, body) =>
        network.CreateVerifierWorkspace({
          subscriptionId,
          resourceGroupName: path.resourceGroup,
          networkManagerName: path.networkManager!,
          workspaceName: path.name,
          ...body,
        }),
      del: (subscriptionId, path) =>
        network.DeleteVerifierWorkspace({
          subscriptionId,
          resourceGroupName: path.resourceGroup,
          networkManagerName: path.networkManager!,
          workspaceName: path.name,
        }),
      updateTags: (subscriptionId, path, tags) =>
        network.UpdateVerifierWorkspace({
          subscriptionId,
          resourceGroupName: path.resourceGroup,
          networkManagerName: path.networkManager!,
          workspaceName: path.name,
          tags,
        }),
      drifted: (observed, _body, news) =>
        (observed.properties?.description ?? undefined) !== news.description,
      toAttrs: (path, observed) => ({
        workspaceName: path.name,
        workspaceId: observed.id ?? "",
        networkManager: path.networkManager!,
        resourceGroup: path.resourceGroup,
        location: observed.location ?? "",
        description: observed.properties?.description,
        tags: userTags(observed.tags),
      }),
      dependsOn: ["Azure.Network.NetworkManager"],
    }),
  );
