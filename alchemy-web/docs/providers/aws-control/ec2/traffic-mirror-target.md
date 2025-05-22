---
title: Managing AWS EC2 TrafficMirrorTargets with Alchemy
description: Learn how to create, update, and manage AWS EC2 TrafficMirrorTargets using Alchemy Cloud Control.
---

# TrafficMirrorTarget

The TrafficMirrorTarget resource lets you create and manage [AWS EC2 TrafficMirrorTargets](https://docs.aws.amazon.com/ec2/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-ec2-trafficmirrortarget.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const trafficmirrortarget = await AWS.EC2.TrafficMirrorTarget("trafficmirrortarget-example", {
  Tags: { Environment: "production", ManagedBy: "Alchemy" },
  Description: "A trafficmirrortarget resource managed by Alchemy",
});
```

## Advanced Configuration

Create a trafficmirrortarget with additional configuration:

```ts
import AWS from "alchemy/aws/control";

const advancedTrafficMirrorTarget = await AWS.EC2.TrafficMirrorTarget(
  "advanced-trafficmirrortarget",
  {
    Tags: {
      Environment: "production",
      Team: "DevOps",
      Project: "MyApp",
      CostCenter: "Engineering",
      ManagedBy: "Alchemy",
    },
    Description: "A trafficmirrortarget resource managed by Alchemy",
  }
);
```

