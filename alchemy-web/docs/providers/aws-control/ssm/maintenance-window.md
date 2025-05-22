---
title: Managing AWS SSM MaintenanceWindows with Alchemy
description: Learn how to create, update, and manage AWS SSM MaintenanceWindows using Alchemy Cloud Control.
---

# MaintenanceWindow

The MaintenanceWindow resource lets you create and manage [AWS SSM MaintenanceWindows](https://docs.aws.amazon.com/ssm/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-ssm-maintenancewindow.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const maintenancewindow = await AWS.SSM.MaintenanceWindow("maintenancewindow-example", {
  AllowUnassociatedTargets: true,
  Cutoff: 1,
  Schedule: "example-schedule",
  Duration: 1,
  Name: "maintenancewindow-",
  Tags: { Environment: "production", ManagedBy: "Alchemy" },
  Description: "A maintenancewindow resource managed by Alchemy",
});
```

## Advanced Configuration

Create a maintenancewindow with additional configuration:

```ts
import AWS from "alchemy/aws/control";

const advancedMaintenanceWindow = await AWS.SSM.MaintenanceWindow("advanced-maintenancewindow", {
  AllowUnassociatedTargets: true,
  Cutoff: 1,
  Schedule: "example-schedule",
  Duration: 1,
  Name: "maintenancewindow-",
  Tags: {
    Environment: "production",
    Team: "DevOps",
    Project: "MyApp",
    CostCenter: "Engineering",
    ManagedBy: "Alchemy",
  },
  Description: "A maintenancewindow resource managed by Alchemy",
});
```

