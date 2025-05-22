---
title: Managing AWS MediaLive CloudWatchAlarmTemplates with Alchemy
description: Learn how to create, update, and manage AWS MediaLive CloudWatchAlarmTemplates using Alchemy Cloud Control.
---

# CloudWatchAlarmTemplate

The CloudWatchAlarmTemplate resource lets you create and manage [AWS MediaLive CloudWatchAlarmTemplates](https://docs.aws.amazon.com/medialive/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-medialive-cloudwatchalarmtemplate.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const cloudwatchalarmtemplate = await AWS.MediaLive.CloudWatchAlarmTemplate(
  "cloudwatchalarmtemplate-example",
  {
    TargetResourceType: "example-targetresourcetype",
    ComparisonOperator: "example-comparisonoperator",
    TreatMissingData: "example-treatmissingdata",
    Period: 1,
    EvaluationPeriods: 1,
    Name: "cloudwatchalarmtemplate-",
    MetricName: "cloudwatchalarmtemplate-metric",
    Statistic: "example-statistic",
    Threshold: 1,
    Tags: { Environment: "production", ManagedBy: "Alchemy" },
    Description: "A cloudwatchalarmtemplate resource managed by Alchemy",
  }
);
```

## Advanced Configuration

Create a cloudwatchalarmtemplate with additional configuration:

```ts
import AWS from "alchemy/aws/control";

const advancedCloudWatchAlarmTemplate = await AWS.MediaLive.CloudWatchAlarmTemplate(
  "advanced-cloudwatchalarmtemplate",
  {
    TargetResourceType: "example-targetresourcetype",
    ComparisonOperator: "example-comparisonoperator",
    TreatMissingData: "example-treatmissingdata",
    Period: 1,
    EvaluationPeriods: 1,
    Name: "cloudwatchalarmtemplate-",
    MetricName: "cloudwatchalarmtemplate-metric",
    Statistic: "example-statistic",
    Threshold: 1,
    Tags: {
      Environment: "production",
      Team: "DevOps",
      Project: "MyApp",
      CostCenter: "Engineering",
      ManagedBy: "Alchemy",
    },
    Description: "A cloudwatchalarmtemplate resource managed by Alchemy",
  }
);
```

