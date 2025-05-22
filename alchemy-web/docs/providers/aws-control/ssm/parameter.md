---
title: Managing AWS SSM Parameters with Alchemy
description: Learn how to create, update, and manage AWS SSM Parameters using Alchemy Cloud Control.
---

# Parameter

The Parameter resource lets you create and manage [AWS SSM Parameters](https://docs.aws.amazon.com/ssm/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-ssm-parameter.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const parameter = await AWS.SSM.Parameter("parameter-example", {
  Type: "example-type",
  Value: "example-value",
  Tags: { Environment: "production", ManagedBy: "Alchemy" },
  Description: "A parameter resource managed by Alchemy",
});
```

## Advanced Configuration

Create a parameter with additional configuration:

```ts
import AWS from "alchemy/aws/control";

const advancedParameter = await AWS.SSM.Parameter("advanced-parameter", {
  Type: "example-type",
  Value: "example-value",
  Tags: {
    Environment: "production",
    Team: "DevOps",
    Project: "MyApp",
    CostCenter: "Engineering",
    ManagedBy: "Alchemy",
  },
  Description: "A parameter resource managed by Alchemy",
});
```

