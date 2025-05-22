---
title: Managing AWS ECS PrimaryTaskSets with Alchemy
description: Learn how to create, update, and manage AWS ECS PrimaryTaskSets using Alchemy Cloud Control.
---

# PrimaryTaskSet

The PrimaryTaskSet resource lets you create and manage [AWS ECS PrimaryTaskSets](https://docs.aws.amazon.com/ecs/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-ecs-primarytaskset.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const primarytaskset = await AWS.ECS.PrimaryTaskSet("primarytaskset-example", {
  TaskSetId: "example-tasksetid",
  Cluster: "example-cluster",
  Service: "example-service",
});
```

