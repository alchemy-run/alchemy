---
title: Managing AWS WorkSpacesWeb UserAccessLoggingSettingss with Alchemy
description: Learn how to create, update, and manage AWS WorkSpacesWeb UserAccessLoggingSettingss using Alchemy Cloud Control.
---

# UserAccessLoggingSettings

The UserAccessLoggingSettings resource lets you create and manage [AWS WorkSpacesWeb UserAccessLoggingSettingss](https://docs.aws.amazon.com/workspacesweb/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-workspacesweb-useraccessloggingsettings.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const useraccessloggingsettings = await AWS.WorkSpacesWeb.UserAccessLoggingSettings(
  "useraccessloggingsettings-example",
  {
    KinesisStreamArn: "example-kinesisstreamarn",
    Tags: { Environment: "production", ManagedBy: "Alchemy" },
  }
);
```

## Advanced Configuration

Create a useraccessloggingsettings with additional configuration:

```ts
import AWS from "alchemy/aws/control";

const advancedUserAccessLoggingSettings = await AWS.WorkSpacesWeb.UserAccessLoggingSettings(
  "advanced-useraccessloggingsettings",
  {
    KinesisStreamArn: "example-kinesisstreamarn",
    Tags: {
      Environment: "production",
      Team: "DevOps",
      Project: "MyApp",
      CostCenter: "Engineering",
      ManagedBy: "Alchemy",
    },
  }
);
```

