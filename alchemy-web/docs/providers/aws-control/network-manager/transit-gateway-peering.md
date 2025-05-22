---
title: Managing AWS NetworkManager TransitGatewayPeerings with Alchemy
description: Learn how to create, update, and manage AWS NetworkManager TransitGatewayPeerings using Alchemy Cloud Control.
---

# TransitGatewayPeering

The TransitGatewayPeering resource lets you create and manage [AWS NetworkManager TransitGatewayPeerings](https://docs.aws.amazon.com/networkmanager/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-networkmanager-transitgatewaypeering.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const transitgatewaypeering = await AWS.NetworkManager.TransitGatewayPeering(
  "transitgatewaypeering-example",
  {
    CoreNetworkId: "example-corenetworkid",
    TransitGatewayArn: "example-transitgatewayarn",
    Tags: { Environment: "production", ManagedBy: "Alchemy" },
  }
);
```

## Advanced Configuration

Create a transitgatewaypeering with additional configuration:

```ts
import AWS from "alchemy/aws/control";

const advancedTransitGatewayPeering = await AWS.NetworkManager.TransitGatewayPeering(
  "advanced-transitgatewaypeering",
  {
    CoreNetworkId: "example-corenetworkid",
    TransitGatewayArn: "example-transitgatewayarn",
    Tags: {
      Environment: "production",
      Team: "DevOps",
      Project: "MyApp",
      CostCenter: "Engineering",
      ManagedBy: "Alchemy",
    },
  }
);
```

