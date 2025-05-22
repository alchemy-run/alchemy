---
title: Managing AWS Logs MetricFilters with Alchemy
description: Learn how to create, update, and manage AWS Logs MetricFilters using Alchemy Cloud Control.
---

# MetricFilter

The MetricFilter resource lets you create and manage [AWS Logs MetricFilters](https://docs.aws.amazon.com/logs/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-logs-metricfilter.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const metricfilter = await AWS.Logs.MetricFilter("metricfilter-example", {
  MetricTransformations: [],
  FilterPattern: "example-filterpattern",
  LogGroupName: "metricfilter-loggroup",
});
```

