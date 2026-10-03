import * as network from "@distilled.cloud/azure/network";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { orUndefinedIfNotFound, userTags } from "../Arm.ts";
import type { Providers } from "../Providers.ts";
import { networkProvider } from "./generic.ts";

export interface DscpConfigurationProps {
  /** Resource group of the DSCP configuration. Changing it replaces the DSCP configuration. */
  resourceGroup: string;
  /**
   * Name of the DSCP configuration: 1-80 letters, digits, `_`, `.`, and `-`. If
   * omitted, a unique name is generated from the app, stage, and logical
   * ID. Changing it replaces the DSCP configuration.
   */
  name?: string;
  /**
   * Azure location. Changing it replaces the DSCP configuration.
   * @default the `Azure.Location` layer, else the profile location, else `eastus`
   */
  location?: string;
  /** DSCP values to mark, e.g. `[46]`. */
  markings?: number[];
  /** Transport protocol matched. @default "All" */
  protocol?: "Icmp" | "Tcp" | "Udp" | "Gre" | "Esp" | "Ah" | "Vxlan" | "All";
  /** Source IP ranges matched. */
  sourceIpRanges?: { startIP?: string; endIP?: string }[];
  /** Destination IP ranges matched. */
  destinationIpRanges?: { startIP?: string; endIP?: string }[];
  /** Source port ranges matched. */
  sourcePortRanges?: { start?: number; end?: number }[];
  /** Destination port ranges matched. */
  destinationPortRanges?: { start?: number; end?: number }[];
  /** QoS definitions (markings per traffic match). */
  qosDefinitionCollection?: network.QosDefinition[];
  /** User tags. Alchemy ownership tags are merged in automatically. */
  tags?: Record<string, string>;
}

export interface DscpConfiguration extends Resource<
  "Azure.Network.DscpConfiguration",
  DscpConfigurationProps,
  {
    /** Name of the DSCP configuration. */
    dscpConfigurationName: string;
    /** ARM resource ID of the DSCP configuration. */
    dscpConfigurationId: string;
    /** Resource group of the DSCP configuration. */
    resourceGroup: string;
    /** Location of the DSCP configuration. */
    location: string;
    /** QoS collection ID assigned by Azure. */
    qosCollectionId: string | undefined;
    /** DSCP markings. */
    markings: number[];
    /** User tags (Alchemy ownership tags stripped). */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * An Azure DSCP configuration — marks traffic from associated virtual
 * machines' network interfaces with DSCP values for QoS on ExpressRoute
 * and other networks. DSCP configurations are free.
 *
 * @see https://learn.microsoft.com/azure/virtual-network/dscp-configuration
 *
 * ### Creating a DSCP Configuration
 * **Example:** Mark voice traffic
 * ```typescript
 * yield* Azure.Network.DscpConfiguration("voice", {
 *   resourceGroup: group.resourceGroupName,
 *   qosDefinitionCollection: [
 *     {
 *       markings: [46],
 *       protocol: "Udp",
 *       destinationPortRanges: [{ start: 5060, end: 5061 }],
 *     },
 *   ],
 * });
 * ```
 *
 * @resource
 */
export const DscpConfiguration = Resource<DscpConfiguration>(
  "Azure.Network.DscpConfiguration",
);

export const DscpConfigurationProvider = () =>
  Provider.succeed(
    DscpConfiguration,
    networkProvider<DscpConfiguration>()({
      label: "DSCP configuration",
      nameAttr: "dscpConfigurationName",
      tracked: true,
      get: (subscriptionId, path) =>
        orUndefinedIfNotFound(
          network.GetDscpConfiguration({
            subscriptionId,
            resourceGroupName: path.resourceGroup,
            dscpConfigurationName: path.name,
          }),
        ),
      put: (subscriptionId, path, body) =>
        network.DscpConfigurationCreateOrUpdate({
          subscriptionId,
          resourceGroupName: path.resourceGroup,
          dscpConfigurationName: path.name,
          ...body,
        }),
      del: (subscriptionId, path) =>
        network.DeleteDscpConfiguration({
          subscriptionId,
          resourceGroupName: path.resourceGroup,
          dscpConfigurationName: path.name,
        }),
      listAll: (subscriptionId) =>
        network.ListDscpConfigurationAll({ subscriptionId }),
      body: (news, { location, tags }) => ({
        location,
        tags,
        properties: {
          markings: news.markings,
          protocol: news.protocol,
          sourceIpRanges: news.sourceIpRanges,
          destinationIpRanges: news.destinationIpRanges,
          sourcePortRanges: news.sourcePortRanges,
          destinationPortRanges: news.destinationPortRanges,
          qosDefinitionCollection: news.qosDefinitionCollection,
        },
      }),
      toAttrs: (path, observed) => ({
        dscpConfigurationName: path.name,
        dscpConfigurationId: observed.id ?? "",
        resourceGroup: path.resourceGroup,
        location: observed.location ?? "",
        qosCollectionId: observed.properties?.qosCollectionId,
        markings: [...(observed.properties?.markings ?? [])],
        tags: userTags(observed.tags),
      }),
    }),
  );
