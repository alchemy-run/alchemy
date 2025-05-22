---
title: Managing AWS EC2 VPNConnectionRoutes with Alchemy
description: Learn how to create, update, and manage AWS EC2 VPNConnectionRoutes using Alchemy Cloud Control.
---

# VPNConnectionRoute

The VPNConnectionRoute resource lets you create and manage [AWS EC2 VPNConnectionRoutes](https://docs.aws.amazon.com/ec2/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-ec2-vpnconnectionroute.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const vpnconnectionroute = await AWS.EC2.VPNConnectionRoute("vpnconnectionroute-example", {
  DestinationCidrBlock: "example-destinationcidrblock",
  VpnConnectionId: "example-vpnconnectionid",
});
```

