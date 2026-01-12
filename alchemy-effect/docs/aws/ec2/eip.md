# Eip

**Type:** `AWS.EC2.EIP`

## Props

| Property | Type | Required | Default | Description |
|----------|------|----------|---------|-------------|
| domain | `"vpc" \| "standard"` | No | "vpc" | Indicates whether the Elastic IP address is for use with instances in a VPC or EC2-Classic. |
| publicIpv4Pool | `Input<string>` | No | - | The ID of an address pool that you own. Use this parameter to let Amazon EC2 select an address from the address pool. |
| networkBorderGroup | `Input<string>` | No | - | A unique set of Availability Zones, Local Zones, or Wavelength Zones from which AWS advertises IP addresses. |
| customerOwnedIpv4Pool | `Input<string>` | No | - | The ID of a customer-owned address pool. Use this parameter to let Amazon EC2 select an address from the address pool. |
| tags | `Record<string, Input<string>>` | No | - | Tags to assign to the Elastic IP. These will be merged with alchemy auto-tags. |

## Attributes

| Attribute | Type | Description |
|-----------|------|-------------|
| allocationId | `AllocationId` | The allocation ID for the Elastic IP address. |
| eipArn | ``arn:aws:ec2:${RegionID}:${AccountID}:elastic-ip/${this["allocationId"]}`` | The Amazon Resource Name (ARN) of the Elastic IP. |
| publicIp | `string` | The Elastic IP address. |
| publicIpv4Pool | `string` | The ID of an address pool. |
| domain | `"vpc" \| "standard"` | Indicates whether the Elastic IP address is for use with instances in a VPC or EC2-Classic. |
| networkBorderGroup | `string` | The network border group. |
| customerOwnedIp | `string` | The customer-owned IP address. |
| customerOwnedIpv4Pool | `string` | The ID of the customer-owned address pool. |
| carrierIp | `string` | The carrier IP address associated with the network interface. |
