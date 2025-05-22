---
title: Managing AWS OpsWorks Stacks with Alchemy
description: Learn how to create, update, and manage AWS OpsWorks Stacks using Alchemy Cloud Control.
---

# Stack

The Stack resource lets you create and manage [AWS OpsWorks Stacks](https://docs.aws.amazon.com/opsworks/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-opsworks-stack.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const stack = await AWS.OpsWorks.Stack("stack-example", {
  DefaultInstanceProfileArn: "example-defaultinstanceprofilearn",
  Name: "stack-",
  ServiceRoleArn: "example-servicerolearn",
  Tags: { Environment: "production", ManagedBy: "Alchemy" },
});
```

## Advanced Configuration

Create a stack with additional configuration:

```ts
import AWS from "alchemy/aws/control";

const advancedStack = await AWS.OpsWorks.Stack("advanced-stack", {
  DefaultInstanceProfileArn: "example-defaultinstanceprofilearn",
  Name: "stack-",
  ServiceRoleArn: "example-servicerolearn",
  Tags: {
    Environment: "production",
    Team: "DevOps",
    Project: "MyApp",
    CostCenter: "Engineering",
    ManagedBy: "Alchemy",
  },
});
```

