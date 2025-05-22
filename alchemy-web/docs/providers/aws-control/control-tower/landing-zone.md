---
title: Managing AWS ControlTower LandingZones with Alchemy
description: Learn how to create, update, and manage AWS ControlTower LandingZones using Alchemy Cloud Control.
---

# LandingZone

The LandingZone resource lets you create and manage [AWS ControlTower LandingZones](https://docs.aws.amazon.com/controltower/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-controltower-landingzone.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const landingzone = await AWS.ControlTower.LandingZone("landingzone-example", {
  Version: "example-version",
  Manifest: {},
  Tags: { Environment: "production", ManagedBy: "Alchemy" },
});
```

## Advanced Configuration

Create a landingzone with additional configuration:

```ts
import AWS from "alchemy/aws/control";

const advancedLandingZone = await AWS.ControlTower.LandingZone("advanced-landingzone", {
  Version: "example-version",
  Manifest: {},
  Tags: {
    Environment: "production",
    Team: "DevOps",
    Project: "MyApp",
    CostCenter: "Engineering",
    ManagedBy: "Alchemy",
  },
});
```

