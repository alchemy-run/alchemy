---
title: Managing AWS DataBrew Schedules with Alchemy
description: Learn how to create, update, and manage AWS DataBrew Schedules using Alchemy Cloud Control.
---

# Schedule

The Schedule resource lets you create and manage [AWS DataBrew Schedules](https://docs.aws.amazon.com/databrew/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-databrew-schedule.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const schedule = await AWS.DataBrew.Schedule("schedule-example", {
  CronExpression: "example-cronexpression",
  Name: "schedule-",
  Tags: { Environment: "production", ManagedBy: "Alchemy" },
});
```

## Advanced Configuration

Create a schedule with additional configuration:

```ts
import AWS from "alchemy/aws/control";

const advancedSchedule = await AWS.DataBrew.Schedule("advanced-schedule", {
  CronExpression: "example-cronexpression",
  Name: "schedule-",
  Tags: {
    Environment: "production",
    Team: "DevOps",
    Project: "MyApp",
    CostCenter: "Engineering",
    ManagedBy: "Alchemy",
  },
});
```

