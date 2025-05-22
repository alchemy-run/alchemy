---
title: Managing AWS Pinpoint Apps with Alchemy
description: Learn how to create, update, and manage AWS Pinpoint Apps using Alchemy Cloud Control.
---

# App

The App resource lets you create and manage [AWS Pinpoint Apps](https://docs.aws.amazon.com/pinpoint/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-pinpoint-app.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const app = await AWS.Pinpoint.App("app-example", {
  Name: "app-",
  Tags: { Environment: "production", ManagedBy: "Alchemy" },
});
```

## Advanced Configuration

Create a app with additional configuration:

```ts
import AWS from "alchemy/aws/control";

const advancedApp = await AWS.Pinpoint.App("advanced-app", {
  Name: "app-",
  Tags: {
    Environment: "production",
    Team: "DevOps",
    Project: "MyApp",
    CostCenter: "Engineering",
    ManagedBy: "Alchemy",
  },
});
```

