---
title: Managing AWS Cloud9 EnvironmentEC2s with Alchemy
description: Learn how to create, update, and manage AWS Cloud9 EnvironmentEC2s using Alchemy Cloud Control.
---

# EnvironmentEC2

The EnvironmentEC2 resource lets you create and manage [AWS Cloud9 EnvironmentEC2s](https://docs.aws.amazon.com/cloud9/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-cloud9-environmentec2.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const environmentec2 = await AWS.Cloud9.EnvironmentEC2("environmentec2-example", {
  ImageId: "example-imageid",
  InstanceType: "example-instancetype",
  Tags: { Environment: "production", ManagedBy: "Alchemy" },
  Description: "A environmentec2 resource managed by Alchemy",
});
```

## Advanced Configuration

Create a environmentec2 with additional configuration:

```ts
import AWS from "alchemy/aws/control";

const advancedEnvironmentEC2 = await AWS.Cloud9.EnvironmentEC2("advanced-environmentec2", {
  ImageId: "example-imageid",
  InstanceType: "example-instancetype",
  Tags: {
    Environment: "production",
    Team: "DevOps",
    Project: "MyApp",
    CostCenter: "Engineering",
    ManagedBy: "Alchemy",
  },
  Description: "A environmentec2 resource managed by Alchemy",
});
```

