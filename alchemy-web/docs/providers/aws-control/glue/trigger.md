---
title: Managing AWS Glue Triggers with Alchemy
description: Learn how to create, update, and manage AWS Glue Triggers using Alchemy Cloud Control.
---

# Trigger

The Trigger resource lets you create and manage [AWS Glue Triggers](https://docs.aws.amazon.com/glue/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-glue-trigger.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const trigger = await AWS.Glue.Trigger("trigger-example", {
  Type: "example-type",
  Actions: [],
  Tags: { Environment: "production", ManagedBy: "Alchemy" },
  Description: "A trigger resource managed by Alchemy",
});
```

## Advanced Configuration

Create a trigger with additional configuration:

```ts
import AWS from "alchemy/aws/control";

const advancedTrigger = await AWS.Glue.Trigger("advanced-trigger", {
  Type: "example-type",
  Actions: [],
  Tags: {
    Environment: "production",
    Team: "DevOps",
    Project: "MyApp",
    CostCenter: "Engineering",
    ManagedBy: "Alchemy",
  },
  Description: "A trigger resource managed by Alchemy",
});
```

