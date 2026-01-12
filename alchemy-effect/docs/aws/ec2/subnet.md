# Subnet

**Type:** `AWS.EC2.Subnet`

## Props

| Property | Type | Required | Default | Description |
|----------|------|----------|---------|-------------|
| vpcId | `Input<VpcId>` | Yes | - | The VPC to create the subnet in. |
| cidrBlock | `string` | No | - | The IPv4 network range for the subnet, in CIDR notation. Required unless using IPAM. |
| ipv6CidrBlock | `string` | No | - | The IPv6 network range for the subnet, in CIDR notation. |
| availabilityZone | `string` | No | - | The Availability Zone for the subnet. |
| availabilityZoneId | `string` | No | - | The ID of the Availability Zone for the subnet. |
| ipv4IpamPoolId | `string` | No | - | The ID of an IPv4 IPAM pool you want to use for allocating this subnet's CIDR. |
| ipv4NetmaskLength | `number` | No | - | The netmask length of the IPv4 CIDR you want to allocate to this subnet from an IPAM pool. |
| ipv6IpamPoolId | `Input<string>` | No | - | The ID of an IPv6 IPAM pool which will be used to allocate this subnet an IPv6 CIDR. |
| ipv6NetmaskLength | `number` | No | - | The netmask length of the IPv6 CIDR you want to allocate to this subnet from an IPAM pool. |
| mapPublicIpOnLaunch | `boolean` | No | false | Whether instances launched in the subnet get public IPv4 addresses. |
| assignIpv6AddressOnCreation | `boolean` | No | false | Whether instances launched in the subnet get IPv6 addresses. |
| enableDns64 | `boolean` | No | false | Whether DNS queries made to the Amazon-provided DNS Resolver in this subnet should return synthetic IPv6 addresses for IPv4-only destinations. |
| enableResourceNameDnsARecordOnLaunch | `boolean` | No | false | Whether to enable resource name DNS A record on launch. |
| enableResourceNameDnsAAAARecordOnLaunch | `boolean` | No | false | Whether to enable resource name DNS AAAA record on launch. |
| hostnameType | `ec2.HostnameType` | No | - | The hostname type for EC2 instances launched into this subnet. |
| tags | `Record<string, Input<string>>` | No | - | Tags to assign to the subnet. These will be merged with alchemy auto-tags (alchemy::app, alchemy::stage, alchemy::id). |

## Attributes

| Attribute | Type | Description |
|-----------|------|-------------|
| vpcId | `Props["vpcId"]` | The ID of the VPC the subnet is in. |
| subnetId | `SubnetId` | The ID of the subnet. |
| subnetArn | ``arn:aws:ec2:${RegionID}:${AccountID}:subnet/${this["subnetId"]}`` | The Amazon Resource Name (ARN) of the subnet. |
| cidrBlock | `string` | The IPv4 CIDR block for the subnet. |
| availabilityZone | `string` | The Availability Zone of the subnet. |
| availabilityZoneId | `string` | The ID of the Availability Zone of the subnet. |
| state | `ec2.SubnetState` | The current state of the subnet. |
| availableIpAddressCount | `number` | The number of available IPv4 addresses in the subnet. |
| mapPublicIpOnLaunch | `boolean` | Whether instances launched in the subnet get public IPv4 addresses. |
| assignIpv6AddressOnCreation | `Props["assignIpv6AddressOnCreation"]` | Whether instances launched in the subnet get IPv6 addresses. |
| defaultForAz | `boolean` | Whether the subnet is the default subnet for the Availability Zone. |
| ownerId | `string` | The ID of the AWS account that owns the subnet. |
| ipv6CidrBlockAssociationSet | `Array<{     associationId: string;     ipv6CidrBlock: string;     ipv6CidrBlockState: {       state: ec2.SubnetCidrBlockStateCode;       statusMessage?: string;     };   }>` | Information about the IPv6 CIDR blocks associated with the subnet. |
| enableDns64 | `boolean` | Whether DNS64 is enabled for the subnet. |
| ipv6Native | `boolean` | Whether this is an IPv6-only subnet. |
| privateDnsNameOptionsOnLaunch | `{     hostnameType?: ec2.HostnameType;     enableResourceNameDnsARecord?: boolean;     enableResourceNameDnsAAAARecord?: boolean;   }` | The private DNS name options on launch. |
