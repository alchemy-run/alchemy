---
title: Managing AWS MediaLive ChannelPlacementGroups with Alchemy
description: Learn how to create, update, and manage AWS MediaLive ChannelPlacementGroups using Alchemy Cloud Control.
---

# ChannelPlacementGroup

The ChannelPlacementGroup resource lets you create and manage [AWS MediaLive ChannelPlacementGroups](https://docs.aws.amazon.com/medialive/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-medialive-channelplacementgroup.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const channelplacementgroup = await AWS.MediaLive.ChannelPlacementGroup(
  "channelplacementgroup-example",
  { Tags: { Environment: "production", ManagedBy: "Alchemy" } }
);
```

## Advanced Configuration

Create a channelplacementgroup with additional configuration:

```ts
import AWS from "alchemy/aws/control";

const advancedChannelPlacementGroup = await AWS.MediaLive.ChannelPlacementGroup(
  "advanced-channelplacementgroup",
  {
    Tags: {
      Environment: "production",
      Team: "DevOps",
      Project: "MyApp",
      CostCenter: "Engineering",
      ManagedBy: "Alchemy",
    },
  }
);
```

