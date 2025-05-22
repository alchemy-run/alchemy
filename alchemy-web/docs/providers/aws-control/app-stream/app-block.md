---
title: Managing AWS AppStream AppBlocks with Alchemy
description: Learn how to create, update, and manage AWS AppStream AppBlocks using Alchemy Cloud Control.
---

# AppBlock

The AppBlock resource lets you create and manage [AWS AppStream AppBlocks](https://docs.aws.amazon.com/appstream/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-appstream-appblock.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const appblock = await AWS.AppStream.AppBlock("appblock-example", {
  SourceS3Location: "example-sources3location",
  Name: "appblock-",
  Tags: { Environment: "production", ManagedBy: "Alchemy" },
  Description: "A appblock resource managed by Alchemy",
});
```

## Advanced Configuration

Create a appblock with additional configuration:

```ts
import AWS from "alchemy/aws/control";

const advancedAppBlock = await AWS.AppStream.AppBlock("advanced-appblock", {
  SourceS3Location: "example-sources3location",
  Name: "appblock-",
  Tags: {
    Environment: "production",
    Team: "DevOps",
    Project: "MyApp",
    CostCenter: "Engineering",
    ManagedBy: "Alchemy",
  },
  Description: "A appblock resource managed by Alchemy",
});
```

