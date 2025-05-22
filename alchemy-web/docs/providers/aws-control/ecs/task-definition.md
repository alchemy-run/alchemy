---
title: Managing AWS ECS TaskDefinitions with Alchemy
description: Learn how to create, update, and manage AWS ECS TaskDefinitions using Alchemy Cloud Control.
---

# TaskDefinition

The TaskDefinition resource lets you create and manage [AWS ECS TaskDefinitions](https://docs.aws.amazon.com/ecs/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-ecs-taskdefinition.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const taskdefinition = await AWS.ECS.TaskDefinition("taskdefinition-example", {
  Tags: { Environment: "production", ManagedBy: "Alchemy" },
});
```

## Advanced Configuration

Create a taskdefinition with additional configuration:

```ts
import AWS from "alchemy/aws/control";

const advancedTaskDefinition = await AWS.ECS.TaskDefinition("advanced-taskdefinition", {
  Tags: {
    Environment: "production",
    Team: "DevOps",
    Project: "MyApp",
    CostCenter: "Engineering",
    ManagedBy: "Alchemy",
  },
});
```

