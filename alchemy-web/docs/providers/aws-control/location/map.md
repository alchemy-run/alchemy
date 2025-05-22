---
title: Managing AWS Location Maps with Alchemy
description: Learn how to create, update, and manage AWS Location Maps using Alchemy Cloud Control.
---

# Map

The Map resource lets you create and manage [AWS Location Maps](https://docs.aws.amazon.com/location/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-location-map.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const map = await AWS.Location.Map("map-example", {
  MapName: "map-map",
  Configuration: "example-configuration",
  Tags: { Environment: "production", ManagedBy: "Alchemy" },
  Description: "A map resource managed by Alchemy",
});
```

## Advanced Configuration

Create a map with additional configuration:

```ts
import AWS from "alchemy/aws/control";

const advancedMap = await AWS.Location.Map("advanced-map", {
  MapName: "map-map",
  Configuration: "example-configuration",
  Tags: {
    Environment: "production",
    Team: "DevOps",
    Project: "MyApp",
    CostCenter: "Engineering",
    ManagedBy: "Alchemy",
  },
  Description: "A map resource managed by Alchemy",
});
```

