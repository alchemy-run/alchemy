---
title: Managing AWS CloudFormation Stacks with Alchemy
description: Learn how to create, update, and manage AWS CloudFormation Stacks using Alchemy Cloud Control.
---

# Stack

The Stack resource lets you create and manage [AWS CloudFormation Stacks](https://docs.aws.amazon.com/cloudformation/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-properties-stack.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const stack = await AWS.CloudFormation.Stack("stack-example", {
  TemplateURL: "example-templateurl",
  Tags: { Environment: "production", ManagedBy: "Alchemy" },
});
```

## Advanced Configuration

Create a stack with additional configuration:

```ts
import AWS from "alchemy/aws/control";

const advancedStack = await AWS.CloudFormation.Stack("advanced-stack", {
  TemplateURL: "example-templateurl",
  Tags: {
    Environment: "production",
    Team: "DevOps",
    Project: "MyApp",
    CostCenter: "Engineering",
    ManagedBy: "Alchemy",
  },
});
```

