---
title: Managing AWS Lambda Functions with Alchemy
description: Learn how to create, update, and manage AWS Lambda Functions using Alchemy Cloud Control.
---

# Function

The Function resource lets you create and manage [AWS Lambda Functions](https://docs.aws.amazon.com/lambda/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-lambda-function.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const awsFunction = await AWS.Lambda.Function("awsFunction-example", {
  Code: "example-code",
  Role: "example-role",
  Tags: { Environment: "production", ManagedBy: "Alchemy" },
  Description: "A function resource managed by Alchemy",
});
```

## Advanced Configuration

Create a function with additional configuration:

```ts
import AWS from "alchemy/aws/control";

const advancedFunction = await AWS.Lambda.Function("advanced-awsFunction", {
  Code: "example-code",
  Role: "example-role",
  Tags: {
    Environment: "production",
    Team: "DevOps",
    Project: "MyApp",
    CostCenter: "Engineering",
    ManagedBy: "Alchemy",
  },
  Description: "A function resource managed by Alchemy",
});
```

