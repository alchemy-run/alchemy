---
title: Managing AWS QuickSight Folders with Alchemy
description: Learn how to create, update, and manage AWS QuickSight Folders using Alchemy Cloud Control.
---

# Folder

The Folder resource lets you create and manage [AWS QuickSight Folders](https://docs.aws.amazon.com/quicksight/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-quicksight-folder.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const folder = await AWS.QuickSight.Folder("folder-example", {
  Tags: { Environment: "production", ManagedBy: "Alchemy" },
});
```

## Advanced Configuration

Create a folder with additional configuration:

```ts
import AWS from "alchemy/aws/control";

const advancedFolder = await AWS.QuickSight.Folder("advanced-folder", {
  Tags: {
    Environment: "production",
    Team: "DevOps",
    Project: "MyApp",
    CostCenter: "Engineering",
    ManagedBy: "Alchemy",
  },
});
```

