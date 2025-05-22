---
title: Managing AWS IoTFleetWise Fleets with Alchemy
description: Learn how to create, update, and manage AWS IoTFleetWise Fleets using Alchemy Cloud Control.
---

# Fleet

The Fleet resource lets you create and manage [AWS IoTFleetWise Fleets](https://docs.aws.amazon.com/iotfleetwise/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-iotfleetwise-fleet.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const fleet = await AWS.IoTFleetWise.Fleet("fleet-example", {
  Id: "example-id",
  SignalCatalogArn: "example-signalcatalogarn",
  Tags: { Environment: "production", ManagedBy: "Alchemy" },
  Description: "A fleet resource managed by Alchemy",
});
```

## Advanced Configuration

Create a fleet with additional configuration:

```ts
import AWS from "alchemy/aws/control";

const advancedFleet = await AWS.IoTFleetWise.Fleet("advanced-fleet", {
  Id: "example-id",
  SignalCatalogArn: "example-signalcatalogarn",
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

