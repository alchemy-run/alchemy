---
title: Managing AWS MediaConvert Presets with Alchemy
description: Learn how to create, update, and manage AWS MediaConvert Presets using Alchemy Cloud Control.
---

# Preset

The Preset resource lets you create and manage [AWS MediaConvert Presets](https://docs.aws.amazon.com/mediaconvert/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-mediaconvert-preset.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const preset = await AWS.MediaConvert.Preset("preset-example", {
  SettingsJson: {},
  Tags: { Environment: "production", ManagedBy: "Alchemy" },
  Description: "A preset resource managed by Alchemy",
});
```

## Advanced Configuration

Create a preset with additional configuration:

```ts
import AWS from "alchemy/aws/control";

const advancedPreset = await AWS.MediaConvert.Preset("advanced-preset", {
  SettingsJson: {},
  Tags: {
    Environment: "production",
    Team: "DevOps",
    Project: "MyApp",
    CostCenter: "Engineering",
    ManagedBy: "Alchemy",
  },
  Description: "A preset resource managed by Alchemy",
});
```

