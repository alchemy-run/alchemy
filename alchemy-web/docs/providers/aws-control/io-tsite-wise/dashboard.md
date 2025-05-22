---
title: Managing AWS IoTSiteWise Dashboards with Alchemy
description: Learn how to create, update, and manage AWS IoTSiteWise Dashboards using Alchemy Cloud Control.
---

# Dashboard

The Dashboard resource lets you create and manage [AWS IoTSiteWise Dashboards](https://docs.aws.amazon.com/iotsitewise/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-iotsitewise-dashboard.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const dashboard = await AWS.IoTSiteWise.Dashboard("dashboard-example", {
  DashboardName: "dashboard-dashboard",
  DashboardDefinition: "example-dashboarddefinition",
  DashboardDescription: "A dashboard resource managed by Alchemy",
  Tags: { Environment: "production", ManagedBy: "Alchemy" },
});
```

## Advanced Configuration

Create a dashboard with additional configuration:

```ts
import AWS from "alchemy/aws/control";

const advancedDashboard = await AWS.IoTSiteWise.Dashboard("advanced-dashboard", {
  DashboardName: "dashboard-dashboard",
  DashboardDefinition: "example-dashboarddefinition",
  DashboardDescription: "A dashboard resource managed by Alchemy",
  Tags: {
    Environment: "production",
    Team: "DevOps",
    Project: "MyApp",
    CostCenter: "Engineering",
    ManagedBy: "Alchemy",
  },
});
```

