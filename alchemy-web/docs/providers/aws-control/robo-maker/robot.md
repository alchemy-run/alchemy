---
title: Managing AWS RoboMaker Robots with Alchemy
description: Learn how to create, update, and manage AWS RoboMaker Robots using Alchemy Cloud Control.
---

# Robot

The Robot resource lets you create and manage [AWS RoboMaker Robots](https://docs.aws.amazon.com/robomaker/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-robomaker-robot.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const robot = await AWS.RoboMaker.Robot("robot-example", {
  Architecture: "example-architecture",
  GreengrassGroupId: "example-greengrassgroupid",
  Tags: { Environment: "production", ManagedBy: "Alchemy" },
});
```

## Advanced Configuration

Create a robot with additional configuration:

```ts
import AWS from "alchemy/aws/control";

const advancedRobot = await AWS.RoboMaker.Robot("advanced-robot", {
  Architecture: "example-architecture",
  GreengrassGroupId: "example-greengrassgroupid",
  Tags: {
    Environment: "production",
    Team: "DevOps",
    Project: "MyApp",
    CostCenter: "Engineering",
    ManagedBy: "Alchemy",
  },
});
```

