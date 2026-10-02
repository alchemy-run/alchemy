import * as Layer from "effect/Layer";
import { AdminRule, AdminRuleProvider } from "./AdminRule.ts";
import {
  AdminRuleCollection,
  AdminRuleCollectionProvider,
} from "./AdminRuleCollection.ts";
import {
  ApplicationGateway,
  ApplicationGatewayProvider,
} from "./ApplicationGateway.ts";
import {
  ApplicationSecurityGroup,
  ApplicationSecurityGroupProvider,
} from "./ApplicationSecurityGroup.ts";
import { AzureFirewall, AzureFirewallProvider } from "./AzureFirewall.ts";
import {
  ConnectivityConfiguration,
  ConnectivityConfigurationProvider,
} from "./ConnectivityConfiguration.ts";
import { FirewallPolicy, FirewallPolicyProvider } from "./FirewallPolicy.ts";
import {
  FirewallPolicyRuleCollectionGroup,
  FirewallPolicyRuleCollectionGroupProvider,
} from "./FirewallPolicyRuleCollectionGroup.ts";
import { IpGroup, IpGroupProvider } from "./IpGroup.ts";
import { LoadBalancer, LoadBalancerProvider } from "./LoadBalancer.ts";
import {
  LocalNetworkGateway,
  LocalNetworkGatewayProvider,
} from "./LocalNetworkGateway.ts";
import { NatGateway, NatGatewayProvider } from "./NatGateway.ts";
import { NetworkGroup, NetworkGroupProvider } from "./NetworkGroup.ts";
import {
  NetworkGroupStaticMember,
  NetworkGroupStaticMemberProvider,
} from "./NetworkGroupStaticMember.ts";
import {
  NetworkInterface,
  NetworkInterfaceProvider,
} from "./NetworkInterface.ts";
import { NetworkManager, NetworkManagerProvider } from "./NetworkManager.ts";
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
import { PublicIpPrefix, PublicIpPrefixProvider } from "./PublicIpPrefix.ts";
import { Route, RouteProvider } from "./Route.ts";
import { RouteFilter, RouteFilterProvider } from "./RouteFilter.ts";
import { RouteFilterRule, RouteFilterRuleProvider } from "./RouteFilterRule.ts";
import { RouteTable, RouteTableProvider } from "./RouteTable.ts";
import {
  SecurityAdminConfiguration,
  SecurityAdminConfigurationProvider,
} from "./SecurityAdminConfiguration.ts";
import { SecurityRule, SecurityRuleProvider } from "./SecurityRule.ts";
import {
  ServiceEndpointPolicy,
  ServiceEndpointPolicyProvider,
} from "./ServiceEndpointPolicy.ts";
import {
  ServiceEndpointPolicyDefinition,
  ServiceEndpointPolicyDefinitionProvider,
} from "./ServiceEndpointPolicyDefinition.ts";
import { Subnet, SubnetProvider } from "./Subnet.ts";
import { VirtualNetwork, VirtualNetworkProvider } from "./VirtualNetwork.ts";
import {
  VirtualNetworkPeering,
  VirtualNetworkPeeringProvider,
} from "./VirtualNetworkPeering.ts";
import {
  WebApplicationFirewallPolicy,
  WebApplicationFirewallPolicyProvider,
} from "./WebApplicationFirewallPolicy.ts";

export const resources = [
  AdminRule,
  AdminRuleCollection,
  ApplicationGateway,
  ApplicationSecurityGroup,
  AzureFirewall,
  ConnectivityConfiguration,
  FirewallPolicy,
  FirewallPolicyRuleCollectionGroup,
  IpGroup,
  LoadBalancer,
  LocalNetworkGateway,
  NatGateway,
  NetworkGroup,
  NetworkGroupStaticMember,
  NetworkInterface,
  NetworkManager,
  NetworkSecurityGroup,
  PrivateDnsZoneGroup,
  PrivateEndpoint,
  PublicIpAddress,
  PublicIpPrefix,
  Route,
  RouteFilter,
  RouteFilterRule,
  RouteTable,
  SecurityAdminConfiguration,
  SecurityRule,
  ServiceEndpointPolicy,
  ServiceEndpointPolicyDefinition,
  Subnet,
  VirtualNetwork,
  VirtualNetworkPeering,
  WebApplicationFirewallPolicy,
];

export const layers = () =>
  Layer.mergeAll(
    Layer.mergeAll(
      AdminRuleProvider(),
      AdminRuleCollectionProvider(),
      ApplicationGatewayProvider(),
      ApplicationSecurityGroupProvider(),
      AzureFirewallProvider(),
      ConnectivityConfigurationProvider(),
      FirewallPolicyProvider(),
      FirewallPolicyRuleCollectionGroupProvider(),
      IpGroupProvider(),
      LoadBalancerProvider(),
      LocalNetworkGatewayProvider(),
      NatGatewayProvider(),
      NetworkGroupProvider(),
      NetworkGroupStaticMemberProvider(),
      NetworkInterfaceProvider(),
      NetworkManagerProvider(),
      NetworkSecurityGroupProvider(),
      PrivateDnsZoneGroupProvider(),
      PrivateEndpointProvider(),
      PublicIpAddressProvider(),
      PublicIpPrefixProvider(),
      RouteProvider(),
      RouteFilterProvider(),
      RouteFilterRuleProvider(),
      RouteTableProvider(),
      SecurityAdminConfigurationProvider(),
      SecurityRuleProvider(),
      ServiceEndpointPolicyProvider(),
      ServiceEndpointPolicyDefinitionProvider(),
      SubnetProvider(),
      VirtualNetworkProvider(),
      VirtualNetworkPeeringProvider(),
      WebApplicationFirewallPolicyProvider(),
    ),
  );
