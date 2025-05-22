---
title: Managing AWS EC2 LocalGatewayRouteTables with Alchemy
description: Learn how to create, update, and manage AWS EC2 LocalGatewayRouteTables using Alchemy Cloud Control.
---

# LocalGatewayRouteTable

The LocalGatewayRouteTable resource lets you create and manage [AWS EC2 LocalGatewayRouteTables](https://docs.aws.amazon.com/ec2/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-ec2-localgatewayroutetable.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const localgatewayroutetable = await AWS.EC2.LocalGatewayRouteTable(
  "localgatewayroutetable-example",
  {
    LocalGatewayId: "example-localgatewayid",
    Tags: { Environment: "production", ManagedBy: "Alchemy" },
  }
);
```

## Advanced Configuration

Create a localgatewayroutetable with additional configuration:

```ts
import AWS from "alchemy/aws/control";

const advancedLocalGatewayRouteTable = await AWS.EC2.LocalGatewayRouteTable(
  "advanced-localgatewayroutetable",
  {
    LocalGatewayId: "example-localgatewayid",
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

