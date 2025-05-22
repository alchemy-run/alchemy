---
title: Managing AWS SSM MaintenanceWindowTargets with Alchemy
description: Learn how to create, update, and manage AWS SSM MaintenanceWindowTargets using Alchemy Cloud Control.
---

# MaintenanceWindowTarget

The MaintenanceWindowTarget resource lets you create and manage [AWS SSM MaintenanceWindowTargets](https://docs.aws.amazon.com/ssm/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-ssm-maintenancewindowtarget.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const maintenancewindowtarget = await AWS.SSM.MaintenanceWindowTarget(
  "maintenancewindowtarget-example",
  {
    WindowId: "example-windowid",
    ResourceType: "example-resourcetype",
    Targets: [],
    Description: "A maintenancewindowtarget resource managed by Alchemy",
  }
);
```

## Advanced Configuration

Create a maintenancewindowtarget with additional configuration:

```ts
import AWS from "alchemy/aws/control";

const advancedMaintenanceWindowTarget = await AWS.SSM.MaintenanceWindowTarget(
  "advanced-maintenancewindowtarget",
  {
    WindowId: "example-windowid",
    ResourceType: "example-resourcetype",
    Targets: [],
    Description: "A maintenancewindowtarget resource managed by Alchemy",
  }
);
```

