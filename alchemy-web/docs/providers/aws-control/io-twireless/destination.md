---
title: Managing AWS IoTWireless Destinations with Alchemy
description: Learn how to create, update, and manage AWS IoTWireless Destinations using Alchemy Cloud Control.
---

# Destination

The Destination resource lets you create and manage [AWS IoTWireless Destinations](https://docs.aws.amazon.com/iotwireless/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-iotwireless-destination.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const destination = await AWS.IoTWireless.Destination("destination-example", {
  Expression: "example-expression",
  ExpressionType: "example-expressiontype",
  Name: "destination-",
  Tags: { Environment: "production", ManagedBy: "Alchemy" },
  Description: "A destination resource managed by Alchemy",
});
```

## Advanced Configuration

Create a destination with additional configuration:

```ts
import AWS from "alchemy/aws/control";

const advancedDestination = await AWS.IoTWireless.Destination("advanced-destination", {
  Expression: "example-expression",
  ExpressionType: "example-expressiontype",
  Name: "destination-",
  Tags: {
    Environment: "production",
    Team: "DevOps",
    Project: "MyApp",
    CostCenter: "Engineering",
    ManagedBy: "Alchemy",
  },
  Description: "A destination resource managed by Alchemy",
});
```

