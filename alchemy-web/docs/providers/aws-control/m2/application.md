---
title: Managing AWS M2 Applications with Alchemy
description: Learn how to create, update, and manage AWS M2 Applications using Alchemy Cloud Control.
---

# Application

The Application resource lets you create and manage [AWS M2 Applications](https://docs.aws.amazon.com/m2/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-m2-application.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const application = await AWS.M2.Application("application-example", {
  EngineType: "example-enginetype",
  Name: "application-",
  Tags: { Environment: "production", ManagedBy: "Alchemy" },
  Description: "A application resource managed by Alchemy",
});
```

## Advanced Configuration

Create a application with additional configuration:

```ts
import AWS from "alchemy/aws/control";

const advancedApplication = await AWS.M2.Application("advanced-application", {
  EngineType: "example-enginetype",
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

