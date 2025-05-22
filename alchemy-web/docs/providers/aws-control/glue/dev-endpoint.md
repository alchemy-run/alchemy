---
title: Managing AWS Glue DevEndpoints with Alchemy
description: Learn how to create, update, and manage AWS Glue DevEndpoints using Alchemy Cloud Control.
---

# DevEndpoint

The DevEndpoint resource lets you create and manage [AWS Glue DevEndpoints](https://docs.aws.amazon.com/glue/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-glue-devendpoint.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const devendpoint = await AWS.Glue.DevEndpoint("devendpoint-example", {
  RoleArn: "example-rolearn",
  Tags: { Environment: "production", ManagedBy: "Alchemy" },
});
```

## Advanced Configuration

Create a devendpoint with additional configuration:

```ts
import AWS from "alchemy/aws/control";

const advancedDevEndpoint = await AWS.Glue.DevEndpoint("advanced-devendpoint", {
  RoleArn: "example-rolearn",
  Tags: {
    Environment: "production",
    Team: "DevOps",
    Project: "MyApp",
    CostCenter: "Engineering",
    ManagedBy: "Alchemy",
  },
});
```

