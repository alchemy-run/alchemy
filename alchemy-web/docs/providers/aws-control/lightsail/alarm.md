---
title: Managing AWS Lightsail Alarms with Alchemy
description: Learn how to create, update, and manage AWS Lightsail Alarms using Alchemy Cloud Control.
---

# Alarm

The Alarm resource lets you create and manage [AWS Lightsail Alarms](https://docs.aws.amazon.com/lightsail/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-lightsail-alarm.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const alarm = await AWS.Lightsail.Alarm("alarm-example", {
  MetricName: "alarm-metric",
  ComparisonOperator: "example-comparisonoperator",
  AlarmName: "alarm-alarm",
  MonitoredResourceName: "alarm-monitoredresource",
  EvaluationPeriods: 1,
  Threshold: 1,
});
```

