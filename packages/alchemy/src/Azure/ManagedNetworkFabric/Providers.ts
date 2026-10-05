import * as Layer from "effect/Layer";
import {
  AccessControlList,
  AccessControlListProvider,
} from "./AccessControlList.ts";
import { ExternalNetwork, ExternalNetworkProvider } from "./ExternalNetwork.ts";
import { InternalNetwork, InternalNetworkProvider } from "./InternalNetwork.ts";
import { InternetGateway, InternetGatewayProvider } from "./InternetGateway.ts";
import {
  InternetGatewayRule,
  InternetGatewayRuleProvider,
} from "./InternetGatewayRule.ts";
import { IpCommunity, IpCommunityProvider } from "./IpCommunity.ts";
import {
  IpExtendedCommunity,
  IpExtendedCommunityProvider,
} from "./IpExtendedCommunity.ts";
import { IpPrefix, IpPrefixProvider } from "./IpPrefix.ts";
import {
  L2IsolationDomain,
  L2IsolationDomainProvider,
} from "./L2IsolationDomain.ts";
import {
  L3IsolationDomain,
  L3IsolationDomainProvider,
} from "./L3IsolationDomain.ts";
import { NeighborGroup, NeighborGroupProvider } from "./NeighborGroup.ts";
import { NetworkFabric, NetworkFabricProvider } from "./NetworkFabric.ts";
import {
  NetworkFabricController,
  NetworkFabricControllerProvider,
} from "./NetworkFabricController.ts";
import { NetworkMonitor, NetworkMonitorProvider } from "./NetworkMonitor.ts";
import { NetworkTap, NetworkTapProvider } from "./NetworkTap.ts";
import { NetworkTapRule, NetworkTapRuleProvider } from "./NetworkTapRule.ts";
import {
  NetworkPacketBroker,
  NetworkPacketBrokerProvider,
} from "./NetworkPacketBroker.ts";
import {
  NetworkToNetworkInterconnect,
  NetworkToNetworkInterconnectProvider,
} from "./NetworkToNetworkInterconnect.ts";
import { RoutePolicy, RoutePolicyProvider } from "./RoutePolicy.ts";

export const resources = [
  AccessControlList,
  ExternalNetwork,
  InternalNetwork,
  InternetGateway,
  InternetGatewayRule,
  IpCommunity,
  IpExtendedCommunity,
  IpPrefix,
  L2IsolationDomain,
  L3IsolationDomain,
  NeighborGroup,
  NetworkFabric,
  NetworkFabricController,
  NetworkMonitor,
  NetworkPacketBroker,
  NetworkTap,
  NetworkTapRule,
  NetworkToNetworkInterconnect,
  RoutePolicy,
];

export const layers = () =>
  Layer.mergeAll(
    AccessControlListProvider(),
    ExternalNetworkProvider(),
    InternalNetworkProvider(),
    InternetGatewayProvider(),
    InternetGatewayRuleProvider(),
    IpCommunityProvider(),
    IpExtendedCommunityProvider(),
    IpPrefixProvider(),
    L2IsolationDomainProvider(),
    L3IsolationDomainProvider(),
    NeighborGroupProvider(),
    NetworkFabricProvider(),
    NetworkFabricControllerProvider(),
    NetworkMonitorProvider(),
    NetworkPacketBrokerProvider(),
    NetworkTapProvider(),
    NetworkTapRuleProvider(),
    NetworkToNetworkInterconnectProvider(),
    RoutePolicyProvider(),
  );
