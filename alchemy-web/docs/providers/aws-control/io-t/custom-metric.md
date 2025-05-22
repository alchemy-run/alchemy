---
title: Managing AWS IoT CustomMetrics with Alchemy
description: Learn how to create, update, and manage AWS IoT CustomMetrics using Alchemy Cloud Control.
---

# CustomMetric

The CustomMetric resource lets you create and manage [AWS IoT CustomMetrics](https://docs.aws.amazon.com/iot/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-iot-custommetric.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const custommetric = await AWS.IoT.CustomMetric("custommetric-example", {
  MetricType: "example-metrictype",
  Tags: { Environment: "production", ManagedBy: "Alchemy" },
});
```

## Advanced Configuration

Create a custommetric with additional configuration:

```ts
import AWS from "alchemy/aws/control";

const advancedCustomMetric = await AWS.IoT.CustomMetric("advanced-custommetric", {
  MetricType: "example-metrictype",
  Tags: {
    Environment: "production",
    Team: "DevOps",
    Project: "MyApp",
    CostCenter: "Engineering",
    ManagedBy: "Alchemy",
  },
});
```

