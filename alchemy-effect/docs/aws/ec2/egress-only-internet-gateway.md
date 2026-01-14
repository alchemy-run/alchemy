# EgressOnlyInternetGateway

**Type:** `AWS.EC2.EgressOnlyInternetGateway`

## Props

| Property | Type                            | Required | Default | Description                                                   |
| -------- | ------------------------------- | -------- | ------- | ------------------------------------------------------------- |
| vpcId    | `Input<VpcId>`                  | Yes      | -       | The VPC for which to create the egress-only internet gateway. |
| tags     | `Record<string, Input<string>>` | No       | -       | Tags to assign to the egress-only internet gateway.           |

## Attributes

| Attribute                    | Type                                                                                                                                                                                                               | Description                                                           |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------- |
| egressOnlyInternetGatewayId  | `EgressOnlyInternetGatewayId`                                                                                                                                                                                      | The ID of the egress-only internet gateway.                           |
| egressOnlyInternetGatewayArn | `EgressOnlyInternetGatewayArn<     this["egressOnlyInternetGatewayId"]   >`                                                                                                                                        | The Amazon Resource Name (ARN) of the egress-only internet gateway.   |
| attachments                  | `Array<{     /**      * The current state of the attachment.      */     state: "attaching" \| "attached" \| "detaching" \| "detached";     /**      * The ID of the VPC.      */     vpcId: Props["vpcId"];   }>` | Information about the attachment of the egress-only internet gateway. |
