---
title: Managing AWS IVS StreamKeys with Alchemy
description: Learn how to create, update, and manage AWS IVS StreamKeys using Alchemy Cloud Control.
---

# StreamKey

The StreamKey resource lets you create and manage [AWS IVS StreamKeys](https://docs.aws.amazon.com/ivs/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-ivs-streamkey.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const streamkey = await AWS.IVS.StreamKey("streamkey-example", {
  ChannelArn: "example-channelarn",
  Tags: { Environment: "production", ManagedBy: "Alchemy" },
});
```

## Advanced Configuration

Create a streamkey with additional configuration:

```ts
import AWS from "alchemy/aws/control";

const advancedStreamKey = await AWS.IVS.StreamKey("advanced-streamkey", {
  ChannelArn: "example-channelarn",
  Tags: {
    Environment: "production",
    Team: "DevOps",
    Project: "MyApp",
    CostCenter: "Engineering",
    ManagedBy: "Alchemy",
  },
});
```

