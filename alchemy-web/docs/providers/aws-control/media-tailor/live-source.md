---
title: Managing AWS MediaTailor LiveSources with Alchemy
description: Learn how to create, update, and manage AWS MediaTailor LiveSources using Alchemy Cloud Control.
---

# LiveSource

The LiveSource resource lets you create and manage [AWS MediaTailor LiveSources](https://docs.aws.amazon.com/mediatailor/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-mediatailor-livesource.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const livesource = await AWS.MediaTailor.LiveSource("livesource-example", {
  LiveSourceName: "livesource-livesource",
  SourceLocationName: "livesource-sourcelocation",
  HttpPackageConfigurations: [],
  Tags: { Environment: "production", ManagedBy: "Alchemy" },
});
```

## Advanced Configuration

Create a livesource with additional configuration:

```ts
import AWS from "alchemy/aws/control";

const advancedLiveSource = await AWS.MediaTailor.LiveSource("advanced-livesource", {
  LiveSourceName: "livesource-livesource",
  SourceLocationName: "livesource-sourcelocation",
  HttpPackageConfigurations: [],
  Tags: {
    Environment: "production",
    Team: "DevOps",
    Project: "MyApp",
    CostCenter: "Engineering",
    ManagedBy: "Alchemy",
  },
});
```

