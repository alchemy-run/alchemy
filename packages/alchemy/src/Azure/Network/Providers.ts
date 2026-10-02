import * as Layer from "effect/Layer";
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
import { PrivateEndpoint, PrivateEndpointProvider } from "./PrivateEndpoint.ts";
import { PublicIpAddress, PublicIpAddressProvider } from "./PublicIpAddress.ts";
import { RouteTable, RouteTableProvider } from "./RouteTable.ts";
import { Subnet, SubnetProvider } from "./Subnet.ts";
import { VirtualNetwork, VirtualNetworkProvider } from "./VirtualNetwork.ts";

export const resources = [
  LoadBalancer,
  NatGateway,
  NetworkInterface,
  NetworkSecurityGroup,
  PrivateEndpoint,
  PublicIpAddress,
  RouteTable,
  Subnet,
  VirtualNetwork,
];
export const layers = () =>
  Layer.mergeAll(
    LoadBalancerProvider(),
    NatGatewayProvider(),
    NetworkInterfaceProvider(),
    NetworkSecurityGroupProvider(),
    PrivateEndpointProvider(),
    PublicIpAddressProvider(),
    RouteTableProvider(),
    SubnetProvider(),
    VirtualNetworkProvider(),
  );
