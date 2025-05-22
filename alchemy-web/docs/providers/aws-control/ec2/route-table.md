---
title: Managing AWS EC2 RouteTables with Alchemy
description: Learn how to create, update, and manage AWS EC2 RouteTables using Alchemy Cloud Control.
---

# RouteTable

The RouteTable resource lets you create and manage [AWS EC2 RouteTables](https://docs.aws.amazon.com/ec2/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-ec2-routetable.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const routetable = await AWS.EC2.RouteTable("routetable-example", {
  VpcId: "example-vpcid",
  Tags: { Environment: "production", ManagedBy: "Alchemy" },
});
```

## Advanced Configuration

Create a routetable with additional configuration:

```ts
import AWS from "alchemy/aws/control";

const advancedRouteTable = await AWS.EC2.RouteTable("advanced-routetable", {
  VpcId: "example-vpcid",
  Tags: {
    Environment: "production",
    Team: "DevOps",
    Project: "MyApp",
    CostCenter: "Engineering",
    ManagedBy: "Alchemy",
  },
});
```

