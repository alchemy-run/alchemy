---
title: Managing AWS FraudDetector Labels with Alchemy
description: Learn how to create, update, and manage AWS FraudDetector Labels using Alchemy Cloud Control.
---

# Label

The Label resource lets you create and manage [AWS FraudDetector Labels](https://docs.aws.amazon.com/frauddetector/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-frauddetector-label.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const label = await AWS.FraudDetector.Label("label-example", {
  Name: "label-",
  Tags: { Environment: "production", ManagedBy: "Alchemy" },
  Description: "A label resource managed by Alchemy",
});
```

## Advanced Configuration

Create a label with additional configuration:

```ts
import AWS from "alchemy/aws/control";

const advancedLabel = await AWS.FraudDetector.Label("advanced-label", {
  Name: "label-",
  Tags: {
    Environment: "production",
    Team: "DevOps",
    Project: "MyApp",
    CostCenter: "Engineering",
    ManagedBy: "Alchemy",
  },
  Description: "A label resource managed by Alchemy",
});
```

