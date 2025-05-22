---
title: Managing AWS EC2 TransitGatewayRoutes with Alchemy
description: Learn how to create, update, and manage AWS EC2 TransitGatewayRoutes using Alchemy Cloud Control.
---

# TransitGatewayRoute

The TransitGatewayRoute resource lets you create and manage [AWS EC2 TransitGatewayRoutes](https://docs.aws.amazon.com/ec2/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-ec2-transitgatewayroute.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const transitgatewayroute = await AWS.EC2.TransitGatewayRoute("transitgatewayroute-example", {
  TransitGatewayRouteTableId: "example-transitgatewayroutetableid",
  DestinationCidrBlock: "example-destinationcidrblock",
});
```

