---
title: Managing AWS MediaConvert JobTemplates with Alchemy
description: Learn how to create, update, and manage AWS MediaConvert JobTemplates using Alchemy Cloud Control.
---

# JobTemplate

The JobTemplate resource lets you create and manage [AWS MediaConvert JobTemplates](https://docs.aws.amazon.com/mediaconvert/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-mediaconvert-jobtemplate.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const jobtemplate = await AWS.MediaConvert.JobTemplate("jobtemplate-example", {
  SettingsJson: {},
  Tags: { Environment: "production", ManagedBy: "Alchemy" },
  Description: "A jobtemplate resource managed by Alchemy",
});
```

## Advanced Configuration

Create a jobtemplate with additional configuration:

```ts
import AWS from "alchemy/aws/control";

const advancedJobTemplate = await AWS.MediaConvert.JobTemplate("advanced-jobtemplate", {
  SettingsJson: {},
  Tags: {
    Environment: "production",
    Team: "DevOps",
    Project: "MyApp",
    CostCenter: "Engineering",
    ManagedBy: "Alchemy",
  },
  Description: "A jobtemplate resource managed by Alchemy",
});
```

