---
title: Managing AWS IoTFleetHub Applications with Alchemy
description: Learn how to create, update, and manage AWS IoTFleetHub Applications using Alchemy Cloud Control.
---

# Application

The Application resource lets you create and manage [AWS IoTFleetHub Applications](https://docs.aws.amazon.com/iotfleethub/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-iotfleethub-application.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const application = await AWS.IoTFleetHub.Application("application-example", {
  ApplicationName: "application-application",
  RoleArn: "example-rolearn",
  Tags: { Environment: "production", ManagedBy: "Alchemy" },
});
```

## Advanced Configuration

Create a application with additional configuration:

```ts
import AWS from "alchemy/aws/control";

const advancedApplication = await AWS.IoTFleetHub.Application("advanced-application", {
  ApplicationName: "application-application",
  RoleArn: "example-rolearn",
  Tags: {
    Environment: "production",
    Team: "DevOps",
    Project: "MyApp",
    CostCenter: "Engineering",
    ManagedBy: "Alchemy",
  },
});
```

