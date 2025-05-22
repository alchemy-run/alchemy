---
title: Managing AWS Batch SchedulingPolicys with Alchemy
description: Learn how to create, update, and manage AWS Batch SchedulingPolicys using Alchemy Cloud Control.
---

# SchedulingPolicy

The SchedulingPolicy resource lets you create and manage [AWS Batch SchedulingPolicys](https://docs.aws.amazon.com/batch/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-batch-schedulingpolicy.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const schedulingpolicy = await AWS.Batch.SchedulingPolicy("schedulingpolicy-example", {
  Tags: { Environment: "production", ManagedBy: "Alchemy" },
});
```

## Advanced Configuration

Create a schedulingpolicy with additional configuration:

```ts
import AWS from "alchemy/aws/control";

const advancedSchedulingPolicy = await AWS.Batch.SchedulingPolicy("advanced-schedulingpolicy", {
  Tags: {
    Environment: "production",
    Team: "DevOps",
    Project: "MyApp",
    CostCenter: "Engineering",
    ManagedBy: "Alchemy",
  },
});
```

