---
title: Managing AWS ECS TaskSets with Alchemy
description: Learn how to create, update, and manage AWS ECS TaskSets using Alchemy Cloud Control.
---

# TaskSet

The TaskSet resource lets you create and manage [AWS ECS TaskSets](https://docs.aws.amazon.com/ecs/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-ecs-taskset.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const taskset = await AWS.ECS.TaskSet("taskset-example", {
  TaskDefinition: "example-taskdefinition",
  Cluster: "example-cluster",
  Service: "example-service",
  Tags: { Environment: "production", ManagedBy: "Alchemy" },
});
```

## Advanced Configuration

Create a taskset with additional configuration:

```ts
import AWS from "alchemy/aws/control";

const advancedTaskSet = await AWS.ECS.TaskSet("advanced-taskset", {
  TaskDefinition: "example-taskdefinition",
  Cluster: "example-cluster",
  Service: "example-service",
  Tags: {
    Environment: "production",
    Team: "DevOps",
    Project: "MyApp",
    CostCenter: "Engineering",
    ManagedBy: "Alchemy",
  },
});
```

