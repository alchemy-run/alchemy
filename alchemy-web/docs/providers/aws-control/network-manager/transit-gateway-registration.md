---
title: Managing AWS NetworkManager TransitGatewayRegistrations with Alchemy
description: Learn how to create, update, and manage AWS NetworkManager TransitGatewayRegistrations using Alchemy Cloud Control.
---

# TransitGatewayRegistration

The TransitGatewayRegistration resource lets you create and manage [AWS NetworkManager TransitGatewayRegistrations](https://docs.aws.amazon.com/networkmanager/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-networkmanager-transitgatewayregistration.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const transitgatewayregistration = await AWS.NetworkManager.TransitGatewayRegistration(
  "transitgatewayregistration-example",
  { GlobalNetworkId: "example-globalnetworkid", TransitGatewayArn: "example-transitgatewayarn" }
);
```

