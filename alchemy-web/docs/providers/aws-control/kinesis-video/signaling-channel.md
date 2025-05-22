---
title: Managing AWS KinesisVideo SignalingChannels with Alchemy
description: Learn how to create, update, and manage AWS KinesisVideo SignalingChannels using Alchemy Cloud Control.
---

# SignalingChannel

The SignalingChannel resource lets you create and manage [AWS KinesisVideo SignalingChannels](https://docs.aws.amazon.com/kinesisvideo/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-kinesisvideo-signalingchannel.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const signalingchannel = await AWS.KinesisVideo.SignalingChannel("signalingchannel-example", {
  Tags: { Environment: "production", ManagedBy: "Alchemy" },
});
```

## Advanced Configuration

Create a signalingchannel with additional configuration:

```ts
import AWS from "alchemy/aws/control";

const advancedSignalingChannel = await AWS.KinesisVideo.SignalingChannel(
  "advanced-signalingchannel",
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

