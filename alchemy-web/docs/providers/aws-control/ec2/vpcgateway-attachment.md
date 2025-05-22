---
title: Managing AWS EC2 VPCGatewayAttachments with Alchemy
description: Learn how to create, update, and manage AWS EC2 VPCGatewayAttachments using Alchemy Cloud Control.
---

# VPCGatewayAttachment

The VPCGatewayAttachment resource lets you create and manage [AWS EC2 VPCGatewayAttachments](https://docs.aws.amazon.com/ec2/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-ec2-vpcgatewayattachment.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const vpcgatewayattachment = await AWS.EC2.VPCGatewayAttachment("vpcgatewayattachment-example", {
  VpcId: "example-vpcid",
});
```

