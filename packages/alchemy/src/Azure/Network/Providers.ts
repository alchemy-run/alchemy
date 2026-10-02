import * as Layer from "effect/Layer";
import {
  ApplicationGateway,
  ApplicationGatewayProvider,
} from "./ApplicationGateway.ts";
import {
  ApplicationSecurityGroup,
  ApplicationSecurityGroupProvider,
} from "./ApplicationSecurityGroup.ts";
import { AzureFirewall, AzureFirewallProvider } from "./AzureFirewall.ts";
import { LoadBalancer, LoadBalancerProvider } from "./LoadBalancer.ts";
import { NatGateway, NatGatewayProvider } from "./NatGateway.ts";
import {
  NetworkInterface,
  NetworkInterfaceProvider,
} from "./NetworkInterface.ts";
import {
  NetworkSecurityGroup,
  NetworkSecurityGroupProvider,
} from "./NetworkSecurityGroup.ts";
import {
  PrivateDnsZoneGroup,
  PrivateDnsZoneGroupProvider,
} from "./PrivateDnsZoneGroup.ts";
import { PrivateEndpoint, PrivateEndpointProvider } from "./PrivateEndpoint.ts";
import { PublicIpAddress, PublicIpAddressProvider } from "./PublicIpAddress.ts";
import { Route, RouteProvider } from "./Route.ts";
import { RouteTable, RouteTableProvider } from "./RouteTable.ts";
import { SecurityRule, SecurityRuleProvider } from "./SecurityRule.ts";
import { Subnet, SubnetProvider } from "./Subnet.ts";
import { VirtualNetwork, VirtualNetworkProvider } from "./VirtualNetwork.ts";
import {
  VirtualNetworkPeering,
  VirtualNetworkPeeringProvider,
} from "./VirtualNetworkPeering.ts";

export const resources = [
  ApplicationGateway,
  ApplicationSecurityGroup,
  AzureFirewall,
  LoadBalancer,
  NatGateway,
  NetworkInterface,
  NetworkSecurityGroup,
  PrivateDnsZoneGroup,
  PrivateEndpoint,
  PublicIpAddress,
  Route,
  RouteTable,
  SecurityRule,
  Subnet,
  VirtualNetwork,
  VirtualNetworkPeering,
];
export const layers = () =>
  Layer.mergeAll(
    ApplicationGatewayProvider(),
    ApplicationSecurityGroupProvider(),
    AzureFirewallProvider(),
    LoadBalancerProvider(),
    NatGatewayProvider(),
    NetworkInterfaceProvider(),
    NetworkSecurityGroupProvider(),
    PrivateDnsZoneGroupProvider(),
    PrivateEndpointProvider(),
    PublicIpAddressProvider(),
    RouteProvider(),
    RouteTableProvider(),
    SecurityRuleProvider(),
    SubnetProvider(),
    VirtualNetworkProvider(),
    VirtualNetworkPeeringProvider(),
  );
