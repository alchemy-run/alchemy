# SecurityGroupRule

**Type:** `AWS.EC2.SecurityGroupRule`

## Props

| Property          | Type                            | Required | Default | Description                                                      |
| ----------------- | ------------------------------- | -------- | ------- | ---------------------------------------------------------------- |
| groupId           | `Input<SecurityGroupId>`        | Yes      | -       | The ID of the security group.                                    |
| type              | `"ingress" \| "egress"`         | Yes      | -       | Whether this is an ingress (inbound) or egress (outbound) rule.  |
| ipProtocol        | `string`                        | Yes      | -       | The IP protocol name or number. Use -1 to specify all protocols. |
| fromPort          | `number`                        | No       | -       | The start of the port range. For ICMP, use the ICMP type number. |
| toPort            | `number`                        | No       | -       | The end of the port range. For ICMP, use the ICMP code.          |
| cidrIpv4          | `string`                        | No       | -       | IPv4 CIDR range to allow.                                        |
| cidrIpv6          | `string`                        | No       | -       | IPv6 CIDR range to allow.                                        |
| referencedGroupId | `Input<SecurityGroupId>`        | No       | -       | ID of a security group to allow traffic from/to.                 |
| prefixListId      | `Input<string>`                 | No       | -       | ID of a prefix list.                                             |
| description       | `string`                        | No       | -       | Description for the rule.                                        |
| tags              | `Record<string, Input<string>>` | No       | -       | Tags to assign to the security group rule.                       |

## Attributes

| Attribute           | Type                                            | Description                                             |
| ------------------- | ----------------------------------------------- | ------------------------------------------------------- |
| securityGroupRuleId | `SecurityGroupRuleId`                           | The ID of the security group rule.                      |
| groupId             | `Props["groupId"]`                              | The ID of the security group.                           |
| groupOwnerId        | `string`                                        | The ID of the AWS account that owns the security group. |
| isEgress            | `Props["type"] extends "egress" ? true : false` | Whether this is an egress rule.                         |
| ipProtocol          | `Props["ipProtocol"]`                           | The IP protocol.                                        |
| fromPort            | `number`                                        | The start of the port range.                            |
| toPort              | `number`                                        | The end of the port range.                              |
| cidrIpv4            | `Props["cidrIpv4"]`                             | The IPv4 CIDR range.                                    |
| cidrIpv6            | `Props["cidrIpv6"]`                             | The IPv6 CIDR range.                                    |
| referencedGroupId   | `string`                                        | The ID of the referenced security group.                |
| prefixListId        | `string`                                        | The ID of the prefix list.                              |
| description         | `Props["description"]`                          | The description.                                        |
