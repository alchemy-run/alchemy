# Route

**Type:** `AWS.EC2.Route`

## Props

| Property                    | Type                  | Required | Default | Description                                                                                                                                            |
| --------------------------- | --------------------- | -------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| routeTableId                | `Input<RouteTableId>` | Yes      | -       | The ID of the route table where the route will be added. Required.                                                                                     |
| destinationCidrBlock        | `string`              | No       | -       | The IPv4 CIDR block used for the destination match. Either destinationCidrBlock, destinationIpv6CidrBlock, or destinationPrefixListId is required.     |
| destinationIpv6CidrBlock    | `string`              | No       | -       | The IPv6 CIDR block used for the destination match. Either destinationCidrBlock, destinationIpv6CidrBlock, or destinationPrefixListId is required.     |
| destinationPrefixListId     | `string`              | No       | -       | The ID of a prefix list used for the destination match. Either destinationCidrBlock, destinationIpv6CidrBlock, or destinationPrefixListId is required. |
| gatewayId                   | `Input<string>`       | No       | -       | The ID of an internet gateway or virtual private gateway.                                                                                              |
| natGatewayId                | `Input<string>`       | No       | -       | The ID of a NAT gateway.                                                                                                                               |
| instanceId                  | `Input<string>`       | No       | -       | The ID of a NAT instance in your VPC. This operation fails unless exactly one network interface is attached.                                           |
| networkInterfaceId          | `Input<string>`       | No       | -       | The ID of a network interface.                                                                                                                         |
| vpcPeeringConnectionId      | `Input<string>`       | No       | -       | The ID of a VPC peering connection.                                                                                                                    |
| transitGatewayId            | `Input<string>`       | No       | -       | The ID of a transit gateway.                                                                                                                           |
| localGatewayId              | `Input<string>`       | No       | -       | The ID of a local gateway.                                                                                                                             |
| carrierGatewayId            | `Input<string>`       | No       | -       | The ID of a carrier gateway. Use for Wavelength Zones only.                                                                                            |
| egressOnlyInternetGatewayId | `Input<string>`       | No       | -       | The ID of an egress-only internet gateway. IPv6 traffic only.                                                                                          |
| coreNetworkArn              | `Input<string>`       | No       | -       | The Amazon Resource Name (ARN) of the core network.                                                                                                    |
| vpcEndpointId               | `Input<string>`       | No       | -       | The ID of a VPC endpoint for Gateway Load Balancer.                                                                                                    |

## Attributes

| Attribute                   | Type                                | Description                                                         |
| --------------------------- | ----------------------------------- | ------------------------------------------------------------------- |
| routeTableId                | `Props["routeTableId"]`             | The ID of the route table.                                          |
| destinationCidrBlock        | `Props["destinationCidrBlock"]`     | The IPv4 CIDR block used for the destination match.                 |
| destinationIpv6CidrBlock    | `Props["destinationIpv6CidrBlock"]` | The IPv6 CIDR block used for the destination match.                 |
| destinationPrefixListId     | `Props["destinationPrefixListId"]`  | The ID of a prefix list used for the destination match.             |
| origin                      | `EC2.RouteOrigin`                   | Describes how the route was created.                                |
| state                       | `EC2.RouteState`                    | The state of the route.                                             |
| gatewayId                   | `string`                            | The ID of the gateway (if applicable).                              |
| natGatewayId                | `string`                            | The ID of the NAT gateway (if applicable).                          |
| instanceId                  | `string`                            | The ID of the NAT instance (if applicable).                         |
| networkInterfaceId          | `string`                            | The ID of the network interface (if applicable).                    |
| vpcPeeringConnectionId      | `string`                            | The ID of the VPC peering connection (if applicable).               |
| transitGatewayId            | `string`                            | The ID of the transit gateway (if applicable).                      |
| localGatewayId              | `string`                            | The ID of the local gateway (if applicable).                        |
| carrierGatewayId            | `string`                            | The ID of the carrier gateway (if applicable).                      |
| egressOnlyInternetGatewayId | `string`                            | The ID of the egress-only internet gateway (if applicable).         |
| coreNetworkArn              | `string`                            | The Amazon Resource Name (ARN) of the core network (if applicable). |
