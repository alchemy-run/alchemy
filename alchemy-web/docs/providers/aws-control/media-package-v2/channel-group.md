---
title: Managing AWS MediaPackageV2 ChannelGroups with Alchemy
description: Learn how to create, update, and manage AWS MediaPackageV2 ChannelGroups using Alchemy Cloud Control.
---

# ChannelGroup

The ChannelGroup resource lets you create and manage [AWS MediaPackageV2 ChannelGroups](https://docs.aws.amazon.com/mediapackagev2/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-mediapackagev2-channelgroup.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const channelgroup = await AWS.MediaPackageV2.ChannelGroup("channelgroup-example", {
  ChannelGroupName: "channelgroup-channelgroup",
  Tags: { Environment: "production", ManagedBy: "Alchemy" },
  Description: "A channelgroup resource managed by Alchemy",
});
```

## Advanced Configuration

Create a channelgroup with additional configuration:

```ts
import AWS from "alchemy/aws/control";

const advancedChannelGroup = await AWS.MediaPackageV2.ChannelGroup("advanced-channelgroup", {
  ChannelGroupName: "channelgroup-channelgroup",
  Tags: {
    Environment: "production",
    Team: "DevOps",
    Project: "MyApp",
    CostCenter: "Engineering",
    ManagedBy: "Alchemy",
  },
  Description: "A channelgroup resource managed by Alchemy",
});
```

