---
title: Managing AWS MediaLive CloudWatchAlarmTemplateGroups with Alchemy
description: Learn how to create, update, and manage AWS MediaLive CloudWatchAlarmTemplateGroups using Alchemy Cloud Control.
---

# CloudWatchAlarmTemplateGroup

The CloudWatchAlarmTemplateGroup resource lets you create and manage [AWS MediaLive CloudWatchAlarmTemplateGroups](https://docs.aws.amazon.com/medialive/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-medialive-cloudwatchalarmtemplategroup.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const cloudwatchalarmtemplategroup = await AWS.MediaLive.CloudWatchAlarmTemplateGroup(
  "cloudwatchalarmtemplategroup-example",
  {
    Name: "cloudwatchalarmtemplategroup-",
    Tags: { Environment: "production", ManagedBy: "Alchemy" },
    Description: "A cloudwatchalarmtemplategroup resource managed by Alchemy",
  }
);
```

## Advanced Configuration

Create a cloudwatchalarmtemplategroup with additional configuration:

```ts
import AWS from "alchemy/aws/control";

const advancedCloudWatchAlarmTemplateGroup = await AWS.MediaLive.CloudWatchAlarmTemplateGroup(
  "advanced-cloudwatchalarmtemplategroup",
  {
    Name: "cloudwatchalarmtemplategroup-",
    Tags: {
      Environment: "production",
      Team: "DevOps",
      Project: "MyApp",
      CostCenter: "Engineering",
      ManagedBy: "Alchemy",
    },
    Description: "A cloudwatchalarmtemplategroup resource managed by Alchemy",
  }
);
```

