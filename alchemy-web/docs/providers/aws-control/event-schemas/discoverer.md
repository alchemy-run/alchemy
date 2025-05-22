---
title: Managing AWS EventSchemas Discoverers with Alchemy
description: Learn how to create, update, and manage AWS EventSchemas Discoverers using Alchemy Cloud Control.
---

# Discoverer

The Discoverer resource lets you create and manage [AWS EventSchemas Discoverers](https://docs.aws.amazon.com/eventschemas/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-eventschemas-discoverer.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const discoverer = await AWS.EventSchemas.Discoverer("discoverer-example", {
  SourceArn: "example-sourcearn",
  Tags: { Environment: "production", ManagedBy: "Alchemy" },
  Description: "A discoverer resource managed by Alchemy",
});
```

## Advanced Configuration

Create a discoverer with additional configuration:

```ts
import AWS from "alchemy/aws/control";

const advancedDiscoverer = await AWS.EventSchemas.Discoverer("advanced-discoverer", {
  SourceArn: "example-sourcearn",
  Tags: {
    Environment: "production",
    Team: "DevOps",
    Project: "MyApp",
    CostCenter: "Engineering",
    ManagedBy: "Alchemy",
  },
  Description: "A discoverer resource managed by Alchemy",
});
```

