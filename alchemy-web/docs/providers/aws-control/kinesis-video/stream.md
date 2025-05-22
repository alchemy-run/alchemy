---
title: Managing AWS KinesisVideo Streams with Alchemy
description: Learn how to create, update, and manage AWS KinesisVideo Streams using Alchemy Cloud Control.
---

# Stream

The Stream resource lets you create and manage [AWS KinesisVideo Streams](https://docs.aws.amazon.com/kinesisvideo/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-kinesisvideo-stream.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const stream = await AWS.KinesisVideo.Stream("stream-example", {
  Tags: { Environment: "production", ManagedBy: "Alchemy" },
});
```

## Advanced Configuration

Create a stream with additional configuration:

```ts
import AWS from "alchemy/aws/control";

const advancedStream = await AWS.KinesisVideo.Stream("advanced-stream", {
  Tags: {
    Environment: "production",
    Team: "DevOps",
    Project: "MyApp",
    CostCenter: "Engineering",
    ManagedBy: "Alchemy",
  },
});
```

