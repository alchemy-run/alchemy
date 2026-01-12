# SecurityGroup

**Type:** `AWS.EC2.SecurityGroup`

## Props

| Property | Type | Required | Default | Description |
|----------|------|----------|---------|-------------|
| vpcId | `Input<VpcId>` | Yes | - | The VPC to create the security group in. |
| groupName | `string` | No | - | The name of the security group. If not provided, a name will be generated. |
| description | `string` | No | "Managed by Alchemy" | A description for the security group. |
| ingress | `SecurityGroupRuleData[]` | No | - | Inbound rules for the security group. |
| egress | `SecurityGroupRuleData[]` | No | - | Outbound rules for the security group. If not specified, allows all outbound traffic by default. |
| tags | `Record<string, Input<string>>` | No | - | Tags to assign to the security group. |

## Attributes

| Attribute | Type | Description |
|-----------|------|-------------|
| groupId | `SecurityGroupId` | The ID of the security group. |
| groupArn | `SecurityGroupArn<this["groupId"]>` | The Amazon Resource Name (ARN) of the security group. |
| groupName | `string` | The name of the security group. |
| description | `string` | The description of the security group. |
| vpcId | `Props["vpcId"]` | The ID of the VPC for the security group. |
| ownerId | `string` | The ID of the AWS account that owns the security group. |
| ingressRules | `Array<{     securityGroupRuleId: string;     ipProtocol: string;     fromPort?: number;     toPort?: number;     cidrIpv4?: string;     cidrIpv6?: string;     referencedGroupId?: string;     prefixListId?: string;     description?: string;     isEgress: false;   }>` | The inbound rules associated with the security group. |
| egressRules | `Array<{     securityGroupRuleId: string;     ipProtocol: string;     fromPort?: number;     toPort?: number;     cidrIpv4?: string;     cidrIpv6?: string;     referencedGroupId?: string;     prefixListId?: string;     description?: string;     isEgress: true;   }>` | The outbound rules associated with the security group. |
