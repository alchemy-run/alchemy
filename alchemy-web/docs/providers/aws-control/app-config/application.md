---
title: Managing AWS AppConfig Applications with Alchemy
description: Learn how to create, update, and manage AWS AppConfig Applications using Alchemy Cloud Control.
---

# Application

The Application resource lets you create and manage [AWS AppConfig Applications](https://docs.aws.amazon.com/appconfig/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-appconfig-application.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const application = await AWS.AppConfig.Application("application-example", {
  Name: "application-",
  Tags: { Environment: "production", ManagedBy: "Alchemy" },
  Description: "A application resource managed by Alchemy",
});
```

## Advanced Configuration

Create a application with additional configuration:

```ts
import AWS from "alchemy/aws/control";

const advancedApplication = await AWS.AppConfig.Application("advanced-application", {
  Name: "application-",
  Tags: {
    Environment: "production",
    Team: "DevOps",
    Project: "MyApp",
    CostCenter: "Engineering",
    ManagedBy: "Alchemy",
  },
  Description: "A application resource managed by Alchemy",
});
```

