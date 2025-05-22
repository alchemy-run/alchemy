---
title: Managing AWS Scheduler ScheduleGroups with Alchemy
description: Learn how to create, update, and manage AWS Scheduler ScheduleGroups using Alchemy Cloud Control.
---

# ScheduleGroup

The ScheduleGroup resource lets you create and manage [AWS Scheduler ScheduleGroups](https://docs.aws.amazon.com/scheduler/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-scheduler-schedulegroup.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const schedulegroup = await AWS.Scheduler.ScheduleGroup("schedulegroup-example", {
  Tags: { Environment: "production", ManagedBy: "Alchemy" },
});
```

## Advanced Configuration

Create a schedulegroup with additional configuration:

```ts
import AWS from "alchemy/aws/control";

const advancedScheduleGroup = await AWS.Scheduler.ScheduleGroup("advanced-schedulegroup", {
  Tags: {
    Environment: "production",
    Team: "DevOps",
    Project: "MyApp",
    CostCenter: "Engineering",
    ManagedBy: "Alchemy",
  },
});
```

