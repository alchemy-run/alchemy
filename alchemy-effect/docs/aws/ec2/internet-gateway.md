# InternetGateway

**Type:** `AWS.EC2.InternetGateway`

## Props

| Property | Type                            | Required | Default | Description                                                                                                                                                                                           |
| -------- | ------------------------------- | -------- | ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| vpcId    | `Input<VpcId>`                  | No       | -       | The VPC to attach the internet gateway to. If provided, the internet gateway will be automatically attached to the VPC. Optional - you can create an unattached internet gateway and attach it later. |
| tags     | `Record<string, Input<string>>` | No       | -       | Tags to assign to the internet gateway. These will be merged with alchemy auto-tags (alchemy::app, alchemy::stage, alchemy::id).                                                                      |

## Attributes

| Attribute          | Type                                                                                                                                                                                                        | Description                                                     |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| internetGatewayId  | `InternetGatewayId`                                                                                                                                                                                         | The ID of the internet gateway.                                 |
| internetGatewayArn | `arn:aws:ec2:${RegionID}:${AccountID}:internet-gateway/${this["internetGatewayId"]}`                                                                                                                        | The Amazon Resource Name (ARN) of the internet gateway.         |
| vpcId              | `Props["vpcId"]`                                                                                                                                                                                            | The ID of the VPC the internet gateway is attached to (if any). |
| ownerId            | `string`                                                                                                                                                                                                    | The ID of the AWS account that owns the internet gateway.       |
| attachments        | `Array<{     /**      * The current state of the attachment.      */     state: "attaching" \| "available" \| "detaching" \| "detached";     /**      * The ID of the VPC.      */     vpcId: string;   }>` | The attachments for the internet gateway.                       |
