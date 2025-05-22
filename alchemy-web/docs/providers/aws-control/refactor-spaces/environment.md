---
title: Managing AWS RefactorSpaces Environments with Alchemy
description: Learn how to create, update, and manage AWS RefactorSpaces Environments using Alchemy Cloud Control.
---

# Environment

The Environment resource lets you create and manage [AWS RefactorSpaces Environments](https://docs.aws.amazon.com/refactorspaces/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-refactorspaces-environment.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const environment = await AWS.RefactorSpaces.Environment("environment-example", {
  Tags: { Environment: "production", ManagedBy: "Alchemy" },
  Description: "A environment resource managed by Alchemy",
});
```

## Advanced Configuration

Create a environment with additional configuration:

```ts
import AWS from "alchemy/aws/control";

const advancedEnvironment = await AWS.RefactorSpaces.Environment("advanced-environment", {
  Tags: {
    Environment: "production",
    Team: "DevOps",
    Project: "MyApp",
    CostCenter: "Engineering",
    ManagedBy: "Alchemy",
  },
  Description: "A environment resource managed by Alchemy",
});
```

