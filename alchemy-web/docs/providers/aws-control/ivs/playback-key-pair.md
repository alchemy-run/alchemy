---
title: Managing AWS IVS PlaybackKeyPairs with Alchemy
description: Learn how to create, update, and manage AWS IVS PlaybackKeyPairs using Alchemy Cloud Control.
---

# PlaybackKeyPair

The PlaybackKeyPair resource lets you create and manage [AWS IVS PlaybackKeyPairs](https://docs.aws.amazon.com/ivs/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-ivs-playbackkeypair.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const playbackkeypair = await AWS.IVS.PlaybackKeyPair("playbackkeypair-example", {
  Tags: { Environment: "production", ManagedBy: "Alchemy" },
});
```

## Advanced Configuration

Create a playbackkeypair with additional configuration:

```ts
import AWS from "alchemy/aws/control";

const advancedPlaybackKeyPair = await AWS.IVS.PlaybackKeyPair("advanced-playbackkeypair", {
  Tags: {
    Environment: "production",
    Team: "DevOps",
    Project: "MyApp",
    CostCenter: "Engineering",
    ManagedBy: "Alchemy",
  },
});
```

