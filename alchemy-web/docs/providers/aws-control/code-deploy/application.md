---
title: Managing AWS CodeDeploy Applications with Alchemy
description: Learn how to create, update, and manage AWS CodeDeploy Applications using Alchemy Cloud Control.
---

# Application

The Application resource lets you create and manage [AWS CodeDeploy Applications](https://docs.aws.amazon.com/codedeploy/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-codedeploy-application.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const application = await AWS.CodeDeploy.Application("application-example", {
  Tags: { Environment: "production", ManagedBy: "Alchemy" },
});
```

## Advanced Configuration

Create a application with additional configuration:

```ts
import AWS from "alchemy/aws/control";

const advancedApplication = await AWS.CodeDeploy.Application("advanced-application", {
  Tags: {
    Environment: "production",
    Team: "DevOps",
    Project: "MyApp",
    CostCenter: "Engineering",
    ManagedBy: "Alchemy",
  },
});
```

