---
title: Managing AWS AutoScaling ScheduledActions with Alchemy
description: Learn how to create, update, and manage AWS AutoScaling ScheduledActions using Alchemy Cloud Control.
---

# ScheduledAction

The ScheduledAction resource lets you create and manage [AWS AutoScaling ScheduledActions](https://docs.aws.amazon.com/autoscaling/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-autoscaling-scheduledaction.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const scheduledaction = await AWS.AutoScaling.ScheduledAction("scheduledaction-example", {
  AutoScalingGroupName: "scheduledaction-autoscalinggroup",
});
```

