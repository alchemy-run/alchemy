---
title: Managing AWS IoT ThingGroups with Alchemy
description: Learn how to create, update, and manage AWS IoT ThingGroups using Alchemy Cloud Control.
---

# ThingGroup

The ThingGroup resource lets you create and manage [AWS IoT ThingGroups](https://docs.aws.amazon.com/iot/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-iot-thinggroup.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const thinggroup = await AWS.IoT.ThingGroup("thinggroup-example", {
  Tags: { Environment: "production", ManagedBy: "Alchemy" },
});
```

## Advanced Configuration

Create a thinggroup with additional configuration:

```ts
import AWS from "alchemy/aws/control";

const advancedThingGroup = await AWS.IoT.ThingGroup("advanced-thinggroup", {
  Tags: {
    Environment: "production",
    Team: "DevOps",
    Project: "MyApp",
    CostCenter: "Engineering",
    ManagedBy: "Alchemy",
  },
});
```

