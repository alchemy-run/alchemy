# NetworkAcl

**Type:** `AWS.EC2.NetworkAcl`

## Props

| Property | Type                            | Required | Default | Description                           |
| -------- | ------------------------------- | -------- | ------- | ------------------------------------- |
| vpcId    | `Input<VpcId>`                  | Yes      | -       | The VPC to create the network ACL in. |
| tags     | `Record<string, Input<string>>` | No       | -       | Tags to assign to the network ACL.    |

## Attributes

| Attribute     | Type                                                                                                                                                                                                                                                                                                         | Description                                           |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------- |
| networkAclId  | `NetworkAclId`                                                                                                                                                                                                                                                                                               | The ID of the network ACL.                            |
| networkAclArn | `NetworkAclArn<this["networkAclId"]>`                                                                                                                                                                                                                                                                        | The Amazon Resource Name (ARN) of the network ACL.    |
| vpcId         | `Props["vpcId"]`                                                                                                                                                                                                                                                                                             | The ID of the VPC for the network ACL.                |
| isDefault     | `boolean`                                                                                                                                                                                                                                                                                                    | Whether this is the default network ACL for the VPC.  |
| ownerId       | `string`                                                                                                                                                                                                                                                                                                     | The ID of the AWS account that owns the network ACL.  |
| entries       | `Array<{     ruleNumber: number;     protocol: string;     ruleAction: EC2.RuleAction;     egress: boolean;     cidrBlock?: string;     ipv6CidrBlock?: string;     icmpTypeCode?: {       code?: number;       type?: number;     };     portRange?: {       from?: number;       to?: number;     };   }>` | The entries (rules) in the network ACL.               |
| associations  | `Array<{     networkAclAssociationId: string;     networkAclId: string;     subnetId: string;   }>`                                                                                                                                                                                                          | The associations between the network ACL and subnets. |
