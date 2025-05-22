---
title: Managing AWS IoT ScheduledAudits with Alchemy
description: Learn how to create, update, and manage AWS IoT ScheduledAudits using Alchemy Cloud Control.
---

# ScheduledAudit

The ScheduledAudit resource lets you create and manage [AWS IoT ScheduledAudits](https://docs.aws.amazon.com/iot/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-iot-scheduledaudit.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const scheduledaudit = await AWS.IoT.ScheduledAudit("scheduledaudit-example", {
  TargetCheckNames: "scheduledaudit-targetchecks",
  Frequency: "example-frequency",
  Tags: { Environment: "production", ManagedBy: "Alchemy" },
});
```

## Advanced Configuration

Create a scheduledaudit with additional configuration:

```ts
import AWS from "alchemy/aws/control";

const advancedScheduledAudit = await AWS.IoT.ScheduledAudit("advanced-scheduledaudit", {
  TargetCheckNames: "scheduledaudit-targetchecks",
  Frequency: "example-frequency",
  Tags: {
    Environment: "production",
    Team: "DevOps",
    Project: "MyApp",
    CostCenter: "Engineering",
    ManagedBy: "Alchemy",
  },
});
```

