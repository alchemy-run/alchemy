---
title: Managing AWS IoT ThingTypes with Alchemy
description: Learn how to create, update, and manage AWS IoT ThingTypes using Alchemy Cloud Control.
---

# ThingType

The ThingType resource lets you create and manage [AWS IoT ThingTypes](https://docs.aws.amazon.com/iot/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-iot-thingtype.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const thingtype = await AWS.IoT.ThingType("thingtype-example", {
  Tags: { Environment: "production", ManagedBy: "Alchemy" },
});
```

## Advanced Configuration

Create a thingtype with additional configuration:

```ts
import AWS from "alchemy/aws/control";

const advancedThingType = await AWS.IoT.ThingType("advanced-thingtype", {
  Tags: {
    Environment: "production",
    Team: "DevOps",
    Project: "MyApp",
    CostCenter: "Engineering",
    ManagedBy: "Alchemy",
  },
});
```

