---
title: Managing AWS EC2 RouteServerEndpoints with Alchemy
description: Learn how to create, update, and manage AWS EC2 RouteServerEndpoints using Alchemy Cloud Control.
---

# RouteServerEndpoint

The RouteServerEndpoint resource lets you create and manage [AWS EC2 RouteServerEndpoints](https://docs.aws.amazon.com/ec2/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-ec2-routeserverendpoint.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const routeserverendpoint = await AWS.EC2.RouteServerEndpoint("routeserverendpoint-example", {
  SubnetId: "example-subnetid",
  RouteServerId: "example-routeserverid",
  Tags: { Environment: "production", ManagedBy: "Alchemy" },
});
```

## Advanced Configuration

Create a routeserverendpoint with additional configuration:

```ts
import AWS from "alchemy/aws/control";

const advancedRouteServerEndpoint = await AWS.EC2.RouteServerEndpoint(
  "advanced-routeserverendpoint",
  {
    SubnetId: "example-subnetid",
    RouteServerId: "example-routeserverid",
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

