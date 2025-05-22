---
title: Managing AWS MediaLive InputSecurityGroups with Alchemy
description: Learn how to create, update, and manage AWS MediaLive InputSecurityGroups using Alchemy Cloud Control.
---

# InputSecurityGroup

The InputSecurityGroup resource lets you create and manage [AWS MediaLive InputSecurityGroups](https://docs.aws.amazon.com/medialive/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-medialive-inputsecuritygroup.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const inputsecuritygroup = await AWS.MediaLive.InputSecurityGroup("inputsecuritygroup-example", {
  Tags: { Environment: "production", ManagedBy: "Alchemy" },
});
```

## Advanced Configuration

Create a inputsecuritygroup with additional configuration:

```ts
import AWS from "alchemy/aws/control";

const advancedInputSecurityGroup = await AWS.MediaLive.InputSecurityGroup(
  "advanced-inputsecuritygroup",
  {
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

