import * as network from "@distilled.cloud/azure/network";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { orUndefinedIfNotFound } from "../Arm.ts";
import type { Providers } from "../Providers.ts";
import { canonical, sameId } from "./common.ts";
import { networkProvider } from "./generic.ts";
import {
  networkManagerChildName,
  networkManagerTags,
} from "./networkManagerShared.ts";

export interface ReachabilityAnalysisIntentProps {
  /** Resource group of the network manager. Changing it replaces the intent. */
  resourceGroup: string;
  /** Name of the network manager. Changing it replaces the intent. */
  networkManager: string;
  /** Name of the parent verifier workspace. Changing it replaces the intent. */
  verifierWorkspace: string;
  /**
   * Name of the intent. If omitted, a unique name is generated from the
   * app, stage, and logical ID. Intents are immutable: any change
   * replaces the intent.
   */
  name?: string;
  /** Description of the intent. */
  description?: string;
  /** ARM ID of the source (VM, NIC, subnet, ...). */
  sourceResourceId: string;
  /** ARM ID of the destination. */
  destinationResourceId: string;
  /** Traffic to analyze. */
  ipTraffic: {
    /** Source IPs or CIDRs, e.g. `["10.0.0.4"]`. */
    sourceIps: string[];
    /** Destination IPs or CIDRs. */
    destinationIps: string[];
    /** Source ports, e.g. `["*"]`. */
    sourcePorts: string[];
    /** Destination ports, e.g. `["443"]`. */
    destinationPorts: string[];
    /** Protocols: `TCP`, `UDP`, `ICMP`, or `Any`. */
    protocols: ("TCP" | "UDP" | "ICMP" | "Any")[];
  };
}

export interface ReachabilityAnalysisIntent extends Resource<
  "Azure.Network.ReachabilityAnalysisIntent",
  ReachabilityAnalysisIntentProps,
  {
    /** Name of the intent. */
    intentName: string;
    /** ARM resource ID of the intent. */
    intentId: string;
    /** Name of the network manager. */
    networkManager: string;
    /** Name of the parent verifier workspace. */
    verifierWorkspace: string;
    /** Resource group of the network manager. */
    resourceGroup: string;
    /** Source resource ID. */
    sourceResourceId: string | undefined;
    /** Destination resource ID. */
    destinationResourceId: string | undefined;
    /** Description. */
    description: string | undefined;
    /** Analyzed traffic. */
    ipTraffic: ReachabilityAnalysisIntentProps["ipTraffic"] | undefined;
  },
  never,
  Providers
> {}

/**
 * A reachability analysis intent in an Azure Virtual Network Verifier
 * workspace — the source, destination, and traffic to check. Start
 * analysis runs against it out of band. It carries no tags: ownership
 * follows the network manager.
 *
 * @see https://learn.microsoft.com/azure/virtual-network-manager/concept-virtual-network-verifier
 *
 * ### Creating an Intent
 * **Example:** Can the web subnet reach the database subnet on 5432?
 * ```typescript
 * yield* Azure.Network.ReachabilityAnalysisIntent("web-to-db", {
 *   resourceGroup: group.resourceGroupName,
 *   networkManager: manager.networkManagerName,
 *   verifierWorkspace: workspace.workspaceName,
 *   sourceResourceId: web.subnetId,
 *   destinationResourceId: db.subnetId,
 *   ipTraffic: {
 *     sourceIps: ["10.0.1.0/24"],
 *     destinationIps: ["10.0.2.0/24"],
 *     sourcePorts: ["*"],
 *     destinationPorts: ["5432"],
 *     protocols: ["TCP"],
 *   },
 * });
 * ```
 *
 * @resource
 */
export const ReachabilityAnalysisIntent = Resource<ReachabilityAnalysisIntent>(
  "Azure.Network.ReachabilityAnalysisIntent",
);

export const ReachabilityAnalysisIntentProvider = () =>
  Provider.succeed(
    ReachabilityAnalysisIntent,
    networkProvider<ReachabilityAnalysisIntent>()({
      label: "reachability analysis intent",
      nameAttr: "intentName",
      parents: ["networkManager", "verifierWorkspace"],
      tracked: false,
      deleteFirst: true,
      physicalName: networkManagerChildName,
      // Intents cannot be updated in place: any change replaces them.
      immutable: (news, output) =>
        !sameId(news.sourceResourceId, output.sourceResourceId) ||
        !sameId(news.destinationResourceId, output.destinationResourceId) ||
        (news.description ?? undefined) !== output.description ||
        canonical(news.ipTraffic) !== canonical(output.ipTraffic),
      drifted: () => false,
      get: (subscriptionId, path) =>
        orUndefinedIfNotFound(
          network.GetReachabilityAnalysisIntent({
            subscriptionId,
            resourceGroupName: path.resourceGroup,
            networkManagerName: path.networkManager!,
            workspaceName: path.verifierWorkspace!,
            reachabilityAnalysisIntentName: path.name,
          }),
        ),
      body: (news) => ({
        properties: {
          description: news.description,
          sourceResourceId: news.sourceResourceId,
          destinationResourceId: news.destinationResourceId,
          ipTraffic: news.ipTraffic,
        },
      }),
      put: (subscriptionId, path, body) =>
        network.CreateReachabilityAnalysisIntent({
          subscriptionId,
          resourceGroupName: path.resourceGroup,
          networkManagerName: path.networkManager!,
          workspaceName: path.verifierWorkspace!,
          reachabilityAnalysisIntentName: path.name,
          ...body,
        }),
      del: (subscriptionId, path) =>
        network.DeleteReachabilityAnalysisIntent({
          subscriptionId,
          resourceGroupName: path.resourceGroup,
          networkManagerName: path.networkManager!,
          workspaceName: path.verifierWorkspace!,
          reachabilityAnalysisIntentName: path.name,
        }),
      ownerTags: networkManagerTags,
      toAttrs: (path, observed) => ({
        intentName: path.name,
        intentId: observed.id ?? "",
        networkManager: path.networkManager!,
        verifierWorkspace: path.verifierWorkspace!,
        resourceGroup: path.resourceGroup,
        sourceResourceId: observed.properties?.sourceResourceId,
        destinationResourceId: observed.properties?.destinationResourceId,
        description: observed.properties?.description,
        ipTraffic: observed.properties?.ipTraffic && {
          sourceIps: [...observed.properties.ipTraffic.sourceIps],
          destinationIps: [...observed.properties.ipTraffic.destinationIps],
          sourcePorts: [...observed.properties.ipTraffic.sourcePorts],
          destinationPorts: [...observed.properties.ipTraffic.destinationPorts],
          protocols: [
            ...observed.properties.ipTraffic.protocols,
          ] as ReachabilityAnalysisIntentProps["ipTraffic"]["protocols"],
        },
      }),
      dependsOn: [
        "Azure.Network.VerifierWorkspace",
        "Azure.Network.NetworkManager",
      ],
    }),
  );
