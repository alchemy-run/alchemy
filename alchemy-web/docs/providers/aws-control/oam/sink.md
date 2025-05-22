---
title: Managing AWS Oam Sinks with Alchemy
description: Learn how to create, update, and manage AWS Oam Sinks using Alchemy Cloud Control.
---

# Sink

The Sink resource lets you create and manage [AWS Oam Sinks](https://docs.aws.amazon.com/oam/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-oam-sink.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const sink = await AWS.Oam.Sink("sink-example", {
  Name: "sink-",
  Tags: { Environment: "production", ManagedBy: "Alchemy" },
});
```

## Advanced Configuration

Create a sink with additional configuration:

```ts
import AWS from "alchemy/aws/control";

const advancedSink = await AWS.Oam.Sink("advanced-sink", {
  Name: "sink-",
  Tags: {
    Environment: "production",
    Team: "DevOps",
    Project: "MyApp",
    CostCenter: "Engineering",
    ManagedBy: "Alchemy",
  },
  Policy: {
    Version: "2012-10-17",
    Statement: [{ Effect: "Allow", Action: ["s3:GetObject"], Resource: "*" }],
  },
});
```

