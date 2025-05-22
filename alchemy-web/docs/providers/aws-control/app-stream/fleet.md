---
title: Managing AWS AppStream Fleets with Alchemy
description: Learn how to create, update, and manage AWS AppStream Fleets using Alchemy Cloud Control.
---

# Fleet

The Fleet resource lets you create and manage [AWS AppStream Fleets](https://docs.aws.amazon.com/appstream/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-appstream-fleet.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const fleet = await AWS.AppStream.Fleet("fleet-example", {
  Name: "fleet-",
  InstanceType: "example-instancetype",
  Tags: { Environment: "production", ManagedBy: "Alchemy" },
  Description: "A fleet resource managed by Alchemy",
});
```

## Advanced Configuration

Create a fleet with additional configuration:

```ts
import AWS from "alchemy/aws/control";

const advancedFleet = await AWS.AppStream.Fleet("advanced-fleet", {
  Name: "fleet-",
  InstanceType: "example-instancetype",
  Tags: {
    Environment: "production",
    Team: "DevOps",
    Project: "MyApp",
    CostCenter: "Engineering",
    ManagedBy: "Alchemy",
  },
  Description: "A fleet resource managed by Alchemy",
});
```

