---
title: Managing AWS EC2 TransitGatewayRouteTables with Alchemy
description: Learn how to create, update, and manage AWS EC2 TransitGatewayRouteTables using Alchemy Cloud Control.
---

# TransitGatewayRouteTable

The TransitGatewayRouteTable resource lets you create and manage [AWS EC2 TransitGatewayRouteTables](https://docs.aws.amazon.com/ec2/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-ec2-transitgatewayroutetable.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const transitgatewayroutetable = await AWS.EC2.TransitGatewayRouteTable(
  "transitgatewayroutetable-example",
  {
    TransitGatewayId: "example-transitgatewayid",
    Tags: { Environment: "production", ManagedBy: "Alchemy" },
  }
);
```

## Advanced Configuration

Create a transitgatewayroutetable with additional configuration:

```ts
import AWS from "alchemy/aws/control";

const advancedTransitGatewayRouteTable = await AWS.EC2.TransitGatewayRouteTable(
  "advanced-transitgatewayroutetable",
  {
    TransitGatewayId: "example-transitgatewayid",
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

