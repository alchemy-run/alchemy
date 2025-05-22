---
title: Managing AWS EC2 ClientVpnRoutes with Alchemy
description: Learn how to create, update, and manage AWS EC2 ClientVpnRoutes using Alchemy Cloud Control.
---

# ClientVpnRoute

The ClientVpnRoute resource lets you create and manage [AWS EC2 ClientVpnRoutes](https://docs.aws.amazon.com/ec2/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-ec2-clientvpnroute.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const clientvpnroute = await AWS.EC2.ClientVpnRoute("clientvpnroute-example", {
  ClientVpnEndpointId: "example-clientvpnendpointid",
  TargetVpcSubnetId: "example-targetvpcsubnetid",
  DestinationCidrBlock: "example-destinationcidrblock",
  Description: "A clientvpnroute resource managed by Alchemy",
});
```

## Advanced Configuration

Create a clientvpnroute with additional configuration:

```ts
import AWS from "alchemy/aws/control";

const advancedClientVpnRoute = await AWS.EC2.ClientVpnRoute("advanced-clientvpnroute", {
  ClientVpnEndpointId: "example-clientvpnendpointid",
  TargetVpcSubnetId: "example-targetvpcsubnetid",
  DestinationCidrBlock: "example-destinationcidrblock",
  Description: "A clientvpnroute resource managed by Alchemy",
});
```

