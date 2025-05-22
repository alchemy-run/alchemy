---
title: Managing AWS GameLift Locations with Alchemy
description: Learn how to create, update, and manage AWS GameLift Locations using Alchemy Cloud Control.
---

# Location

The Location resource lets you create and manage [AWS GameLift Locations](https://docs.aws.amazon.com/gamelift/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-gamelift-location.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const location = await AWS.GameLift.Location("location-example", {
  LocationName: "location-location",
  Tags: { Environment: "production", ManagedBy: "Alchemy" },
});
```

## Advanced Configuration

Create a location with additional configuration:

```ts
import AWS from "alchemy/aws/control";

const advancedLocation = await AWS.GameLift.Location("advanced-location", {
  LocationName: "location-location",
  Tags: {
    Environment: "production",
    Team: "DevOps",
    Project: "MyApp",
    CostCenter: "Engineering",
    ManagedBy: "Alchemy",
  },
});
```

