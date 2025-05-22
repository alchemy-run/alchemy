---
title: Managing AWS AppConfig Extensions with Alchemy
description: Learn how to create, update, and manage AWS AppConfig Extensions using Alchemy Cloud Control.
---

# Extension

The Extension resource lets you create and manage [AWS AppConfig Extensions](https://docs.aws.amazon.com/appconfig/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-appconfig-extension.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const extension = await AWS.AppConfig.Extension("extension-example", {
  Actions: {},
  Name: "extension-",
  Tags: { Environment: "production", ManagedBy: "Alchemy" },
  Description: "A extension resource managed by Alchemy",
});
```

## Advanced Configuration

Create a extension with additional configuration:

```ts
import AWS from "alchemy/aws/control";

const advancedExtension = await AWS.AppConfig.Extension("advanced-extension", {
  Actions: {},
  Name: "extension-",
  Tags: {
    Environment: "production",
    Team: "DevOps",
    Project: "MyApp",
    CostCenter: "Engineering",
    ManagedBy: "Alchemy",
  },
  Description: "A extension resource managed by Alchemy",
});
```

