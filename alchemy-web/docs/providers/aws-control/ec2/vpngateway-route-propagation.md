---
title: Managing AWS EC2 VPNGatewayRoutePropagations with Alchemy
description: Learn how to create, update, and manage AWS EC2 VPNGatewayRoutePropagations using Alchemy Cloud Control.
---

# VPNGatewayRoutePropagation

The VPNGatewayRoutePropagation resource lets you create and manage [AWS EC2 VPNGatewayRoutePropagations](https://docs.aws.amazon.com/ec2/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-ec2-vpngatewayroutepropagation.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const vpngatewayroutepropagation = await AWS.EC2.VPNGatewayRoutePropagation(
  "vpngatewayroutepropagation-example",
  { RouteTableIds: ["example-routetableids-1"], VpnGatewayId: "example-vpngatewayid" }
);
```

