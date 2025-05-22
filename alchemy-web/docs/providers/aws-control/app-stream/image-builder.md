---
title: Managing AWS AppStream ImageBuilders with Alchemy
description: Learn how to create, update, and manage AWS AppStream ImageBuilders using Alchemy Cloud Control.
---

# ImageBuilder

The ImageBuilder resource lets you create and manage [AWS AppStream ImageBuilders](https://docs.aws.amazon.com/appstream/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-appstream-imagebuilder.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const imagebuilder = await AWS.AppStream.ImageBuilder("imagebuilder-example", {
  Name: "imagebuilder-",
  InstanceType: "example-instancetype",
  Tags: { Environment: "production", ManagedBy: "Alchemy" },
  Description: "A imagebuilder resource managed by Alchemy",
});
```

## Advanced Configuration

Create a imagebuilder with additional configuration:

```ts
import AWS from "alchemy/aws/control";

const advancedImageBuilder = await AWS.AppStream.ImageBuilder("advanced-imagebuilder", {
  Name: "imagebuilder-",
  InstanceType: "example-instancetype",
  Tags: {
    Environment: "production",
    Team: "DevOps",
    Project: "MyApp",
    CostCenter: "Engineering",
    ManagedBy: "Alchemy",
  },
  Description: "A imagebuilder resource managed by Alchemy",
});
```

