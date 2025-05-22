---
title: Managing AWS EC2 LocalGatewayRoutes with Alchemy
description: Learn how to create, update, and manage AWS EC2 LocalGatewayRoutes using Alchemy Cloud Control.
---

# LocalGatewayRoute

The LocalGatewayRoute resource lets you create and manage [AWS EC2 LocalGatewayRoutes](https://docs.aws.amazon.com/ec2/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-ec2-localgatewayroute.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const localgatewayroute = await AWS.EC2.LocalGatewayRoute("localgatewayroute-example", {
  LocalGatewayRouteTableId: "example-localgatewayroutetableid",
  DestinationCidrBlock: "example-destinationcidrblock",
});
```

