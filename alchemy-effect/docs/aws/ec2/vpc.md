# Vpc

**Type:** `AWS.EC2.VPC`

## Props

| Property                        | Type                            | Required | Default   | Description                                                                                                         |
| ------------------------------- | ------------------------------- | -------- | --------- | ------------------------------------------------------------------------------------------------------------------- |
| cidrBlock                       | `string`                        | No       | -         | The IPv4 network range for the VPC, in CIDR notation. Required unless using IPAM.                                   |
| ipv4IpamPoolId                  | `Input<string>`                 | No       | -         | The ID of an IPv4 IPAM pool you want to use for allocating this VPC's CIDR.                                         |
| ipv4NetmaskLength               | `number`                        | No       | -         | The netmask length of the IPv4 CIDR you want to allocate to this VPC from an IPAM pool.                             |
| ipv6IpamPoolId                  | `Input<string>`                 | No       | -         | The ID of an IPv6 IPAM pool which will be used to allocate this VPC an IPv6 CIDR.                                   |
| ipv6NetmaskLength               | `number`                        | No       | -         | The netmask length of the IPv6 CIDR you want to allocate to this VPC from an IPAM pool.                             |
| ipv6CidrBlock                   | `string`                        | No       | -         | Requests an Amazon-provided IPv6 CIDR block with a /56 prefix length for the VPC.                                   |
| ipv6Pool                        | `Input<string>`                 | No       | -         | The ID of an IPv6 address pool from which to allocate the IPv6 CIDR block.                                          |
| ipv6CidrBlockNetworkBorderGroup | `Input<string>`                 | No       | -         | The Availability Zone or Local Zone Group name for the IPv6 CIDR block.                                             |
| instanceTenancy                 | `EC2.Tenancy`                   | No       | "default" | The tenancy options for instances launched into the VPC.                                                            |
| enableDnsSupport                | `boolean`                       | No       | true      | Whether DNS resolution is supported for the VPC.                                                                    |
| enableDnsHostnames              | `boolean`                       | No       | true      | Whether instances launched in the VPC get DNS hostnames.                                                            |
| amazonProvidedIpv6CidrBlock     | `boolean`                       | No       | -         | Requests an Amazon-provided IPv6 CIDR block with a /56 prefix length for the VPC.                                   |
| tags                            | `Record<string, Input<string>>` | No       | -         | Tags to assign to the VPC. These will be merged with alchemy auto-tags (alchemy::app, alchemy::stage, alchemy::id). |

## Attributes

| Attribute                   | Type                                                                                                                                                                                                                                | Description                                                     |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| vpcId                       | `VpcId`                                                                                                                                                                                                                             | The ID of the VPC.                                              |
| vpcArn                      | `arn:aws:ec2:${RegionID}:${AccountID}:vpc/${this["vpcId"]}`                                                                                                                                                                         | The Amazon Resource Name (ARN) of the VPC.                      |
| cidrBlock                   | `string`                                                                                                                                                                                                                            | The primary IPv4 CIDR block for the VPC.                        |
| dhcpOptionsId               | `string`                                                                                                                                                                                                                            | The ID of the set of DHCP options associated with the VPC.      |
| state                       | `EC2.VpcState`                                                                                                                                                                                                                      | The current state of the VPC.                                   |
| isDefault                   | `boolean`                                                                                                                                                                                                                           | Whether the VPC is the default VPC.                             |
| ownerId                     | `string`                                                                                                                                                                                                                            | The ID of the AWS account that owns the VPC.                    |
| cidrBlockAssociationSet     | `Array<{     associationId: string;     cidrBlock: string;     cidrBlockState: {       state: EC2.VpcCidrBlockStateCode;       statusMessage?: string;     };   }>`                                                                 | Information about the IPv4 CIDR blocks associated with the VPC. |
| ipv6CidrBlockAssociationSet | `Array<{     associationId: string;     ipv6CidrBlock: string;     ipv6CidrBlockState: {       state: EC2.VpcCidrBlockStateCode;       statusMessage?: string;     };     networkBorderGroup?: string;     ipv6Pool?: string;   }>` | Information about the IPv6 CIDR blocks associated with the VPC. |
| tags                        | `Record<string, string>`                                                                                                                                                                                                            | -                                                               |
