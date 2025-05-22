---
title: Managing AWS Location Trackers with Alchemy
description: Learn how to create, update, and manage AWS Location Trackers using Alchemy Cloud Control.
---

# Tracker

The Tracker resource lets you create and manage [AWS Location Trackers](https://docs.aws.amazon.com/location/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-location-tracker.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const tracker = await AWS.Location.Tracker("tracker-example", {
  TrackerName: "tracker-tracker",
  Tags: { Environment: "production", ManagedBy: "Alchemy" },
  Description: "A tracker resource managed by Alchemy",
});
```

## Advanced Configuration

Create a tracker with additional configuration:

```ts
import AWS from "alchemy/aws/control";

const advancedTracker = await AWS.Location.Tracker("advanced-tracker", {
  TrackerName: "tracker-tracker",
  Tags: {
    Environment: "production",
    Team: "DevOps",
    Project: "MyApp",
    CostCenter: "Engineering",
    ManagedBy: "Alchemy",
  },
  Description: "A tracker resource managed by Alchemy",
});
```

