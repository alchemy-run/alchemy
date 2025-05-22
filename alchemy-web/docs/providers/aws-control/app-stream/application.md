---
title: Managing AWS AppStream Applications with Alchemy
description: Learn how to create, update, and manage AWS AppStream Applications using Alchemy Cloud Control.
---

# Application

The Application resource lets you create and manage [AWS AppStream Applications](https://docs.aws.amazon.com/appstream/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-appstream-application.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const application = await AWS.AppStream.Application("application-example", {
  Platforms: ["example-platforms-1"],
  AppBlockArn: "example-appblockarn",
  InstanceFamilies: ["example-instancefamilies-1"],
  LaunchPath: "example-launchpath",
  Name: "application-",
  IconS3Location: "example-icons3location",
  Tags: { Environment: "production", ManagedBy: "Alchemy" },
  Description: "A application resource managed by Alchemy",
});
```

## Advanced Configuration

Create a application with additional configuration:

```ts
import AWS from "alchemy/aws/control";

const advancedApplication = await AWS.AppStream.Application("advanced-application", {
  Platforms: ["example-platforms-1"],
  AppBlockArn: "example-appblockarn",
  InstanceFamilies: ["example-instancefamilies-1"],
  LaunchPath: "example-launchpath",
  Name: "application-",
  IconS3Location: "example-icons3location",
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

