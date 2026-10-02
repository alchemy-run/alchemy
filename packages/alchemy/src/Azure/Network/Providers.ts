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
  ApplicationGatewayConnectionApproval,
  ApplicationGatewayConnectionApprovalProvider,
} from "./ApplicationGatewayConnectionApproval.ts";
import {
  ApplicationSecurityGroup,
  ApplicationSecurityGroupProvider,
} from "./ApplicationSecurityGroup.ts";
import {
  ApplicationSecurityGroupAddressPrefixSet,
  ApplicationSecurityGroupAddressPrefixSetProvider,
} from "./ApplicationSecurityGroupAddressPrefixSet.ts";
import { AzureFirewall, AzureFirewallProvider } from "./AzureFirewall.ts";
import {
  ConnectionAnalyzer,
  ConnectionAnalyzerProvider,
} from "./ConnectionAnalyzer.ts";
import {
  ConnectionMonitor,
  ConnectionMonitorProvider,
} from "./ConnectionMonitor.ts";
import {
  ConnectivityConfiguration,
  ConnectivityConfigurationProvider,
} from "./ConnectivityConfiguration.ts";
import {
  DscpConfiguration,
  DscpConfigurationProvider,
} from "./DscpConfiguration.ts";
import { FirewallPolicy, FirewallPolicyProvider } from "./FirewallPolicy.ts";
import {
  FirewallPolicyRuleCollectionGroup,
  FirewallPolicyRuleCollectionGroupProvider,
} from "./FirewallPolicyRuleCollectionGroup.ts";
import { FlowLog, FlowLogProvider } from "./FlowLog.ts";
import { InboundNatRule, InboundNatRuleProvider } from "./InboundNatRule.ts";
import { IpGroup, IpGroupProvider } from "./IpGroup.ts";
import { IpamPool, IpamPoolProvider } from "./IpamPool.ts";
import {
  IpamPoolStaticCidr,
  IpamPoolStaticCidrProvider,
} from "./IpamPoolStaticCidr.ts";
import { LoadBalancer, LoadBalancerProvider } from "./LoadBalancer.ts";
import {
  LoadBalancerBackendAddressPool,
  LoadBalancerBackendAddressPoolProvider,
} from "./LoadBalancerBackendAddressPool.ts";
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
import {
  NetworkInterfaceTapConfiguration,
  NetworkInterfaceTapConfigurationProvider,
} from "./NetworkInterfaceTapConfiguration.ts";
import { NetworkManager, NetworkManagerProvider } from "./NetworkManager.ts";
import {
  NetworkManagerConnection,
  NetworkManagerConnectionProvider,
} from "./NetworkManagerConnection.ts";
import {
  NetworkSecurityGroup,
  NetworkSecurityGroupProvider,
} from "./NetworkSecurityGroup.ts";
import {
  NetworkSecurityPerimeter,
  NetworkSecurityPerimeterProvider,
} from "./NetworkSecurityPerimeter.ts";
import {
  NetworkSecurityPerimeterAccessRule,
  NetworkSecurityPerimeterAccessRuleProvider,
} from "./NetworkSecurityPerimeterAccessRule.ts";
import {
  NetworkSecurityPerimeterAssociation,
  NetworkSecurityPerimeterAssociationProvider,
} from "./NetworkSecurityPerimeterAssociation.ts";
import {
  NetworkSecurityPerimeterLink,
  NetworkSecurityPerimeterLinkProvider,
} from "./NetworkSecurityPerimeterLink.ts";
import {
  NetworkSecurityPerimeterLoggingConfiguration,
  NetworkSecurityPerimeterLoggingConfigurationProvider,
} from "./NetworkSecurityPerimeterLoggingConfiguration.ts";
import {
  NetworkSecurityPerimeterProfile,
  NetworkSecurityPerimeterProfileProvider,
} from "./NetworkSecurityPerimeterProfile.ts";
import { NetworkWatcher, NetworkWatcherProvider } from "./NetworkWatcher.ts";
import {
  PrivateDnsZoneGroup,
  PrivateDnsZoneGroupProvider,
} from "./PrivateDnsZoneGroup.ts";
import { PrivateEndpoint, PrivateEndpointProvider } from "./PrivateEndpoint.ts";
import {
  PrivateLinkService,
  PrivateLinkServiceProvider,
} from "./PrivateLinkService.ts";
import {
  PrivateLinkServiceConnectionApproval,
  PrivateLinkServiceConnectionApprovalProvider,
} from "./PrivateLinkServiceConnectionApproval.ts";
import { PublicIpAddress, PublicIpAddressProvider } from "./PublicIpAddress.ts";
import { PublicIpPrefix, PublicIpPrefixProvider } from "./PublicIpPrefix.ts";
import {
  ReachabilityAnalysisIntent,
  ReachabilityAnalysisIntentProvider,
} from "./ReachabilityAnalysisIntent.ts";
import { Route, RouteProvider } from "./Route.ts";
import { RouteFilter, RouteFilterProvider } from "./RouteFilter.ts";
import { RouteFilterRule, RouteFilterRuleProvider } from "./RouteFilterRule.ts";
import { RouteTable, RouteTableProvider } from "./RouteTable.ts";
import {
  RoutingConfiguration,
  RoutingConfigurationProvider,
} from "./RoutingConfiguration.ts";
import { RoutingRule, RoutingRuleProvider } from "./RoutingRule.ts";
import {
  RoutingRuleCollection,
  RoutingRuleCollectionProvider,
} from "./RoutingRuleCollection.ts";
import { ScopeConnection, ScopeConnectionProvider } from "./ScopeConnection.ts";
import {
  SecurityAdminConfiguration,
  SecurityAdminConfigurationProvider,
} from "./SecurityAdminConfiguration.ts";
import { SecurityRule, SecurityRuleProvider } from "./SecurityRule.ts";
import {
  SecurityUserConfiguration,
  SecurityUserConfigurationProvider,
} from "./SecurityUserConfiguration.ts";
import {
  SecurityUserRule,
  SecurityUserRuleProvider,
} from "./SecurityUserRule.ts";
import {
  SecurityUserRuleCollection,
  SecurityUserRuleCollectionProvider,
} from "./SecurityUserRuleCollection.ts";
import {
  ServiceEndpointPolicy,
  ServiceEndpointPolicyProvider,
} from "./ServiceEndpointPolicy.ts";
import {
  ServiceEndpointPolicyDefinition,
  ServiceEndpointPolicyDefinitionProvider,
} from "./ServiceEndpointPolicyDefinition.ts";
import { Subnet, SubnetProvider } from "./Subnet.ts";
import {
  VerifierWorkspace,
  VerifierWorkspaceProvider,
} from "./VerifierWorkspace.ts";
import { VirtualNetwork, VirtualNetworkProvider } from "./VirtualNetwork.ts";
import {
  VirtualNetworkPeering,
  VirtualNetworkPeeringProvider,
} from "./VirtualNetworkPeering.ts";
import {
  VirtualNetworkTap,
  VirtualNetworkTapProvider,
} from "./VirtualNetworkTap.ts";
import {
  WebApplicationFirewallPolicy,
  WebApplicationFirewallPolicyProvider,
} from "./WebApplicationFirewallPolicy.ts";

export const resources = [
  AdminRule,
  AdminRuleCollection,
  ApplicationGateway,
  ApplicationGatewayConnectionApproval,
  ApplicationSecurityGroup,
  ApplicationSecurityGroupAddressPrefixSet,
  AzureFirewall,
  ConnectionAnalyzer,
  ConnectionMonitor,
  ConnectivityConfiguration,
  DscpConfiguration,
  FirewallPolicy,
  FirewallPolicyRuleCollectionGroup,
  FlowLog,
  InboundNatRule,
  IpGroup,
  IpamPool,
  IpamPoolStaticCidr,
  LoadBalancer,
  LoadBalancerBackendAddressPool,
  LocalNetworkGateway,
  NatGateway,
  NetworkGroup,
  NetworkGroupStaticMember,
  NetworkInterface,
  NetworkInterfaceTapConfiguration,
  NetworkManager,
  NetworkManagerConnection,
  NetworkSecurityGroup,
  NetworkSecurityPerimeter,
  NetworkSecurityPerimeterAccessRule,
  NetworkSecurityPerimeterAssociation,
  NetworkSecurityPerimeterLink,
  NetworkSecurityPerimeterLoggingConfiguration,
  NetworkSecurityPerimeterProfile,
  NetworkWatcher,
  PrivateDnsZoneGroup,
  PrivateEndpoint,
  PrivateLinkService,
  PrivateLinkServiceConnectionApproval,
  PublicIpAddress,
  PublicIpPrefix,
  ReachabilityAnalysisIntent,
  Route,
  RouteFilter,
  RouteFilterRule,
  RouteTable,
  RoutingConfiguration,
  RoutingRule,
  RoutingRuleCollection,
  ScopeConnection,
  SecurityAdminConfiguration,
  SecurityRule,
  SecurityUserConfiguration,
  SecurityUserRule,
  SecurityUserRuleCollection,
  ServiceEndpointPolicy,
  ServiceEndpointPolicyDefinition,
  Subnet,
  VerifierWorkspace,
  VirtualNetwork,
  VirtualNetworkPeering,
  VirtualNetworkTap,
  WebApplicationFirewallPolicy,
];

export const layers = () =>
  Layer.mergeAll(
    Layer.mergeAll(
      AdminRuleProvider(),
      AdminRuleCollectionProvider(),
      ApplicationGatewayProvider(),
      ApplicationGatewayConnectionApprovalProvider(),
      ApplicationSecurityGroupProvider(),
      ApplicationSecurityGroupAddressPrefixSetProvider(),
      AzureFirewallProvider(),
      ConnectionAnalyzerProvider(),
      ConnectionMonitorProvider(),
      ConnectivityConfigurationProvider(),
      DscpConfigurationProvider(),
      FirewallPolicyProvider(),
      FirewallPolicyRuleCollectionGroupProvider(),
      FlowLogProvider(),
      InboundNatRuleProvider(),
      IpGroupProvider(),
      IpamPoolProvider(),
      IpamPoolStaticCidrProvider(),
      LoadBalancerProvider(),
      LoadBalancerBackendAddressPoolProvider(),
      LocalNetworkGatewayProvider(),
      NatGatewayProvider(),
      NetworkGroupProvider(),
      NetworkGroupStaticMemberProvider(),
      NetworkInterfaceProvider(),
      NetworkInterfaceTapConfigurationProvider(),
      NetworkManagerProvider(),
      NetworkManagerConnectionProvider(),
      NetworkSecurityGroupProvider(),
      NetworkSecurityPerimeterProvider(),
      NetworkSecurityPerimeterAccessRuleProvider(),
      NetworkSecurityPerimeterAssociationProvider(),
      NetworkSecurityPerimeterLinkProvider(),
      NetworkSecurityPerimeterLoggingConfigurationProvider(),
      NetworkSecurityPerimeterProfileProvider(),
      NetworkWatcherProvider(),
      PrivateDnsZoneGroupProvider(),
      PrivateEndpointProvider(),
      PrivateLinkServiceProvider(),
      PrivateLinkServiceConnectionApprovalProvider(),
    ),
    Layer.mergeAll(
      PublicIpAddressProvider(),
      PublicIpPrefixProvider(),
      ReachabilityAnalysisIntentProvider(),
      RouteProvider(),
      RouteFilterProvider(),
      RouteFilterRuleProvider(),
      RouteTableProvider(),
      RoutingConfigurationProvider(),
      RoutingRuleProvider(),
      RoutingRuleCollectionProvider(),
      ScopeConnectionProvider(),
      SecurityAdminConfigurationProvider(),
      SecurityRuleProvider(),
      SecurityUserConfigurationProvider(),
      SecurityUserRuleProvider(),
      SecurityUserRuleCollectionProvider(),
      ServiceEndpointPolicyProvider(),
      ServiceEndpointPolicyDefinitionProvider(),
      SubnetProvider(),
      VerifierWorkspaceProvider(),
      VirtualNetworkProvider(),
      VirtualNetworkPeeringProvider(),
      VirtualNetworkTapProvider(),
      WebApplicationFirewallPolicyProvider(),
    ),
  );
