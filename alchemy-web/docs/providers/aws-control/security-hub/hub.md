---
title: Managing AWS SecurityHub Hubs with Alchemy
description: Learn how to create, update, and manage AWS SecurityHub Hubs using Alchemy Cloud Control.
---

# Hub

The Hub resource lets you create and manage [AWS SecurityHub Hubs](https://docs.aws.amazon.com/securityhub/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-securityhub-hub.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const hub = await AWS.SecurityHub.Hub("hub-example", {
  Tags: { Environment: "production", ManagedBy: "Alchemy" },
});
```

## Advanced Configuration

Create a hub with additional configuration:

```ts
import AWS from "alchemy/aws/control";

const advancedHub = await AWS.SecurityHub.Hub("advanced-hub", {
  Tags: {
    Environment: "production",
    Team: "DevOps",
    Project: "MyApp",
    CostCenter: "Engineering",
    ManagedBy: "Alchemy",
  },
});
```

