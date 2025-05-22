---
title: Managing AWS MediaLive SignalMaps with Alchemy
description: Learn how to create, update, and manage AWS MediaLive SignalMaps using Alchemy Cloud Control.
---

# SignalMap

The SignalMap resource lets you create and manage [AWS MediaLive SignalMaps](https://docs.aws.amazon.com/medialive/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-medialive-signalmap.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const signalmap = await AWS.MediaLive.SignalMap("signalmap-example", {
  DiscoveryEntryPointArn: "example-discoveryentrypointarn",
  Name: "signalmap-",
  Tags: { Environment: "production", ManagedBy: "Alchemy" },
  Description: "A signalmap resource managed by Alchemy",
});
```

## Advanced Configuration

Create a signalmap with additional configuration:

```ts
import AWS from "alchemy/aws/control";

const advancedSignalMap = await AWS.MediaLive.SignalMap("advanced-signalmap", {
  DiscoveryEntryPointArn: "example-discoveryentrypointarn",
  Name: "signalmap-",
  Tags: {
    Environment: "production",
    Team: "DevOps",
    Project: "MyApp",
    CostCenter: "Engineering",
    ManagedBy: "Alchemy",
  },
  Description: "A signalmap resource managed by Alchemy",
});
```

