---
title: Managing AWS MediaLive SdiSources with Alchemy
description: Learn how to create, update, and manage AWS MediaLive SdiSources using Alchemy Cloud Control.
---

# SdiSource

The SdiSource resource lets you create and manage [AWS MediaLive SdiSources](https://docs.aws.amazon.com/medialive/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-medialive-sdisource.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const sdisource = await AWS.MediaLive.SdiSource("sdisource-example", {
  Type: "example-type",
  Name: "sdisource-",
  Tags: { Environment: "production", ManagedBy: "Alchemy" },
});
```

## Advanced Configuration

Create a sdisource with additional configuration:

```ts
import AWS from "alchemy/aws/control";

const advancedSdiSource = await AWS.MediaLive.SdiSource("advanced-sdisource", {
  Type: "example-type",
  Name: "sdisource-",
  Tags: {
    Environment: "production",
    Team: "DevOps",
    Project: "MyApp",
    CostCenter: "Engineering",
    ManagedBy: "Alchemy",
  },
});
```

