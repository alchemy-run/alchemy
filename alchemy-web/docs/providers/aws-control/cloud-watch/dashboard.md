---
title: Managing AWS CloudWatch Dashboards with Alchemy
description: Learn how to create, update, and manage AWS CloudWatch Dashboards using Alchemy Cloud Control.
---

# Dashboard

The Dashboard resource lets you create and manage [AWS CloudWatch Dashboards](https://docs.aws.amazon.com/cloudwatch/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-cloudwatch-dashboard.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const dashboard = await AWS.CloudWatch.Dashboard("dashboard-example", {
  DashboardBody: "example-dashboardbody",
});
```

