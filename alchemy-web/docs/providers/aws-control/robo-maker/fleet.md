---
title: Managing AWS RoboMaker Fleets with Alchemy
description: Learn how to create, update, and manage AWS RoboMaker Fleets using Alchemy Cloud Control.
---

# Fleet

The Fleet resource lets you create and manage [AWS RoboMaker Fleets](https://docs.aws.amazon.com/robomaker/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-robomaker-fleet.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const fleet = await AWS.RoboMaker.Fleet("fleet-example", {
  Tags: { Environment: "production", ManagedBy: "Alchemy" },
});
```

## Advanced Configuration

Create a fleet with additional configuration:

```ts
import AWS from "alchemy/aws/control";

const advancedFleet = await AWS.RoboMaker.Fleet("advanced-fleet", {
  Tags: {
    Environment: "production",
    Team: "DevOps",
    Project: "MyApp",
    CostCenter: "Engineering",
    ManagedBy: "Alchemy",
  },
});
```

