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

import { VirtualWan, VirtualWanProvider } from "./VirtualWan.ts";

import { VpnSite, VpnSiteProvider } from "./VpnSite.ts";

import {
  VpnServerConfiguration,
  VpnServerConfigurationProvider,
} from "./VpnServerConfiguration.ts";

import {
  VpnServerConfigurationPolicyGroup,
  VpnServerConfigurationPolicyGroupProvider,
} from "./VpnServerConfigurationPolicyGroup.ts";

import { VirtualHub, VirtualHubProvider } from "./VirtualHub.ts";

import {
  HubVirtualNetworkConnection,
  HubVirtualNetworkConnectionProvider,
} from "./HubVirtualNetworkConnection.ts";

import { HubRouteTable, HubRouteTableProvider } from "./HubRouteTable.ts";

import {
  VirtualHubBgpConnection,
  VirtualHubBgpConnectionProvider,
} from "./VirtualHubBgpConnection.ts";

import { VpnGateway, VpnGatewayProvider } from "./VpnGateway.ts";

import { VpnConnection, VpnConnectionProvider } from "./VpnConnection.ts";

import {
  VpnGatewayNatRule,
  VpnGatewayNatRuleProvider,
} from "./VpnGatewayNatRule.ts";

import { P2sVpnGateway, P2sVpnGatewayProvider } from "./P2sVpnGateway.ts";

import {
  VirtualHubIpConfiguration,
  VirtualHubIpConfigurationProvider,
} from "./VirtualHubIpConfiguration.ts";

import { RouteMap, RouteMapProvider } from "./RouteMap.ts";

import { RoutingIntent, RoutingIntentProvider } from "./RoutingIntent.ts";

import {
  VirtualHubConnectionPolicy,
  VirtualHubConnectionPolicyProvider,
} from "./VirtualHubConnectionPolicy.ts";

import { BastionHost, BastionHostProvider } from "./BastionHost.ts";

import {
  ExpressRouteCircuit,
  ExpressRouteCircuitProvider,
} from "./ExpressRouteCircuit.ts";

import {
  ExpressRouteCircuitAuthorization,
  ExpressRouteCircuitAuthorizationProvider,
} from "./ExpressRouteCircuitAuthorization.ts";

import {
  FirewallPolicyIdpsSignatureOverrides,
  FirewallPolicyIdpsSignatureOverridesProvider,
} from "./FirewallPolicyIdpsSignatureOverrides.ts";

import {
  FirewallPolicyKubeSelectorGroup,
  FirewallPolicyKubeSelectorGroupProvider,
} from "./FirewallPolicyKubeSelectorGroup.ts";

import { ServiceGateway, ServiceGatewayProvider } from "./ServiceGateway.ts";

import {
  VirtualNetworkAppliance,
  VirtualNetworkApplianceProvider,
} from "./VirtualNetworkAppliance.ts";

import {
  DdosProtectionPlan,
  DdosProtectionPlanProvider,
} from "./DdosProtectionPlan.ts";

import { CustomIpPrefix, CustomIpPrefixProvider } from "./CustomIpPrefix.ts";

import {
  ExpressRoutePort,
  ExpressRoutePortProvider,
} from "./ExpressRoutePort.ts";

import {
  ExpressRoutePortAuthorization,
  ExpressRoutePortAuthorizationProvider,
} from "./ExpressRoutePortAuthorization.ts";

import { ExpressRouteLag, ExpressRouteLagProvider } from "./ExpressRouteLag.ts";

import {
  InterconnectGroup,
  InterconnectGroupProvider,
} from "./InterconnectGroup.ts";

import {
  SecurityPartnerProvider,
  SecurityPartnerProviderProvider,
} from "./SecurityPartnerProvider.ts";

import {
  NetworkVirtualAppliance,
  NetworkVirtualApplianceProvider,
} from "./NetworkVirtualAppliance.ts";

import {
  NetworkVirtualApplianceConnection,
  NetworkVirtualApplianceConnectionProvider,
} from "./NetworkVirtualApplianceConnection.ts";

import {
  NetworkVirtualApplianceInboundSecurityRule,
  NetworkVirtualApplianceInboundSecurityRuleProvider,
} from "./NetworkVirtualApplianceInboundSecurityRule.ts";

import {
  ExpressRouteCircuitConnection,
  ExpressRouteCircuitConnectionProvider,
} from "./ExpressRouteCircuitConnection.ts";

export const resources = [
  AdminRule,
  AdminRuleCollection,
  ApplicationGateway,
  ApplicationGatewayConnectionApproval,
  ApplicationSecurityGroup,
  ApplicationSecurityGroupAddressPrefixSet,
  AzureFirewall,
  BastionHost,
  ConnectionAnalyzer,
  ConnectionMonitor,
  ConnectivityConfiguration,
  DscpConfiguration,
  FirewallPolicy,
  FirewallPolicyRuleCollectionGroup,
  FlowLog,
  HubRouteTable,
  HubVirtualNetworkConnection,
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
  P2sVpnGateway,
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
  RouteMap,
  RouteTable,
  RoutingConfiguration,
  RoutingIntent,
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
  VirtualHub,
  VirtualHubBgpConnection,
  VirtualHubConnectionPolicy,
  VirtualHubIpConfiguration,
  VirtualNetwork,
  VirtualNetworkPeering,
  VirtualNetworkTap,
  VirtualWan,
  VpnConnection,
  VpnGateway,
  VpnGatewayNatRule,
  VpnServerConfiguration,
  VpnServerConfigurationPolicyGroup,
  VpnSite,
  WebApplicationFirewallPolicy,
  ExpressRouteCircuit,
  ExpressRouteCircuitAuthorization,
  FirewallPolicyIdpsSignatureOverrides,
  FirewallPolicyKubeSelectorGroup,
  ServiceGateway,
  VirtualNetworkAppliance,
  DdosProtectionPlan,
  CustomIpPrefix,
  ExpressRoutePort,
  ExpressRoutePortAuthorization,
  ExpressRouteLag,
  InterconnectGroup,
  SecurityPartnerProvider,
  NetworkVirtualAppliance,
  NetworkVirtualApplianceConnection,
  NetworkVirtualApplianceInboundSecurityRule,
  ExpressRouteCircuitConnection,
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
    // Virtual WAN, gateways, ExpressRoute, and appliances.
    Layer.mergeAll(
      BastionHostProvider(),
      HubRouteTableProvider(),
      HubVirtualNetworkConnectionProvider(),
      P2sVpnGatewayProvider(),
      RouteMapProvider(),
      RoutingIntentProvider(),
      VirtualHubBgpConnectionProvider(),
      VirtualHubConnectionPolicyProvider(),
      VirtualHubIpConfigurationProvider(),
      VirtualHubProvider(),
      VirtualWanProvider(),
      VpnConnectionProvider(),
      VpnGatewayNatRuleProvider(),
      VpnGatewayProvider(),
      VpnServerConfigurationPolicyGroupProvider(),
      VpnServerConfigurationProvider(),
      VpnSiteProvider(),
      ExpressRouteCircuitProvider(),
      ExpressRouteCircuitAuthorizationProvider(),
      FirewallPolicyIdpsSignatureOverridesProvider(),
      FirewallPolicyKubeSelectorGroupProvider(),
      ServiceGatewayProvider(),
      VirtualNetworkApplianceProvider(),
      DdosProtectionPlanProvider(),
      CustomIpPrefixProvider(),
      ExpressRoutePortProvider(),
      ExpressRoutePortAuthorizationProvider(),
      ExpressRouteLagProvider(),
      InterconnectGroupProvider(),
      SecurityPartnerProviderProvider(),
      NetworkVirtualApplianceProvider(),
      NetworkVirtualApplianceConnectionProvider(),
      NetworkVirtualApplianceInboundSecurityRuleProvider(),
      ExpressRouteCircuitConnectionProvider(),
    ),
  );
