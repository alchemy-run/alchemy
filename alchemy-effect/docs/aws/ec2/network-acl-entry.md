# NetworkAclEntry

**Type:** `AWS.EC2.NetworkAclEntry`

## Props

| Property | Type | Required | Default | Description |
|----------|------|----------|---------|-------------|
| networkAclId | `Input<NetworkAclId>` | Yes | - | The ID of the network ACL. |
| ruleNumber | `number` | Yes | - | The rule number for the entry (1-32766). Rules are evaluated in order from lowest to highest. |
| protocol | `string` | Yes | - | The protocol number. A value of "-1" means all protocols. Common values: 6 (TCP), 17 (UDP), 1 (ICMP) |
| ruleAction | `EC2.RuleAction` | Yes | - | Whether to allow or deny the traffic that matches the rule. |
| egress | `boolean` | No | false (ingress) | Whether this is an egress (outbound) rule. |
| cidrBlock | `string` | No | - | The IPv4 CIDR block. Either cidrBlock or ipv6CidrBlock must be specified. |
| ipv6CidrBlock | `string` | No | - | The IPv6 CIDR block. Either cidrBlock or ipv6CidrBlock must be specified. |
| icmpTypeCode | `{     /**      * The ICMP code. Use -1 to specify all codes.      */     code?: number;     /**      * The ICMP type. Use -1 to specify all types.      */     type?: number;   }` | No | - | ICMP type and code. Required if protocol is 1 (ICMP) or 58 (ICMPv6). |
| portRange | `{     /**      * The first port in the range.      */     from?: number;     /**      * The last port in the range.      */     to?: number;   }` | No | - | The port range for TCP/UDP protocols. |

## Attributes

| Attribute | Type | Description |
|-----------|------|-------------|
| networkAclId | `Props["networkAclId"]` | The ID of the network ACL. |
| ruleNumber | `Props["ruleNumber"]` | The rule number. |
| egress | `boolean` | Whether this is an egress rule. |
| protocol | `Props["protocol"]` | The protocol. |
| ruleAction | `Props["ruleAction"]` | The rule action (allow or deny). |
| cidrBlock | `Props["cidrBlock"]` | The IPv4 CIDR block. |
| ipv6CidrBlock | `Props["ipv6CidrBlock"]` | The IPv6 CIDR block. |
| icmpTypeCode | `Props["icmpTypeCode"]` | The ICMP type and code. |
| portRange | `Props["portRange"]` | The port range. |
