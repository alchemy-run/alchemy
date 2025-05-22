---
title: Managing AWS ImageBuilder Components with Alchemy
description: Learn how to create, update, and manage AWS ImageBuilder Components using Alchemy Cloud Control.
---

# Component

The Component resource lets you create and manage [AWS ImageBuilder Components](https://docs.aws.amazon.com/imagebuilder/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-imagebuilder-component.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const component = await AWS.ImageBuilder.Component("component-example", {
  Platform: "example-platform",
  Version: "example-version",
  Name: "component-",
  Tags: { Environment: "production", ManagedBy: "Alchemy" },
  Description: "A component resource managed by Alchemy",
});
```

## Advanced Configuration

Create a component with additional configuration:

```ts
import AWS from "alchemy/aws/control";

const advancedComponent = await AWS.ImageBuilder.Component("advanced-component", {
  Platform: "example-platform",
  Version: "example-version",
  Name: "component-",
  Tags: {
    Environment: "production",
    Team: "DevOps",
    Project: "MyApp",
    CostCenter: "Engineering",
    ManagedBy: "Alchemy",
  },
  Description: "A component resource managed by Alchemy",
});
```

