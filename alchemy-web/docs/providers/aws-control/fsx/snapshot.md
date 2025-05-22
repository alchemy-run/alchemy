---
title: Managing AWS FSx Snapshots with Alchemy
description: Learn how to create, update, and manage AWS FSx Snapshots using Alchemy Cloud Control.
---

# Snapshot

The Snapshot resource lets you create and manage [AWS FSx Snapshots](https://docs.aws.amazon.com/fsx/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-fsx-snapshot.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const snapshot = await AWS.FSx.Snapshot("snapshot-example", {
  VolumeId: "example-volumeid",
  Name: "snapshot-",
  Tags: { Environment: "production", ManagedBy: "Alchemy" },
});
```

## Advanced Configuration

Create a snapshot with additional configuration:

```ts
import AWS from "alchemy/aws/control";

const advancedSnapshot = await AWS.FSx.Snapshot("advanced-snapshot", {
  VolumeId: "example-volumeid",
  Name: "snapshot-",
  Tags: {
    Environment: "production",
    Team: "DevOps",
    Project: "MyApp",
    CostCenter: "Engineering",
    ManagedBy: "Alchemy",
  },
});
```

