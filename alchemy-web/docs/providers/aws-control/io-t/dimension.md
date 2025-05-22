---
title: Managing AWS IoT Dimensions with Alchemy
description: Learn how to create, update, and manage AWS IoT Dimensions using Alchemy Cloud Control.
---

# Dimension

The Dimension resource lets you create and manage [AWS IoT Dimensions](https://docs.aws.amazon.com/iot/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-iot-dimension.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const dimension = await AWS.IoT.Dimension("dimension-example", {
  Type: "example-type",
  StringValues: ["example-stringvalues-1"],
  Tags: { Environment: "production", ManagedBy: "Alchemy" },
});
```

## Advanced Configuration

Create a dimension with additional configuration:

```ts
import AWS from "alchemy/aws/control";

const advancedDimension = await AWS.IoT.Dimension("advanced-dimension", {
  Type: "example-type",
  StringValues: ["example-stringvalues-1"],
  Tags: {
    Environment: "production",
    Team: "DevOps",
    Project: "MyApp",
    CostCenter: "Engineering",
    ManagedBy: "Alchemy",
  },
});
```

