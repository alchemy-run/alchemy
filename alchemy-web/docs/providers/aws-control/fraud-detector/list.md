---
title: Managing AWS FraudDetector Lists with Alchemy
description: Learn how to create, update, and manage AWS FraudDetector Lists using Alchemy Cloud Control.
---

# List

The List resource lets you create and manage [AWS FraudDetector Lists](https://docs.aws.amazon.com/frauddetector/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-frauddetector-list.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const list = await AWS.FraudDetector.List("list-example", {
  Name: "list-",
  Tags: { Environment: "production", ManagedBy: "Alchemy" },
  Description: "A list resource managed by Alchemy",
});
```

## Advanced Configuration

Create a list with additional configuration:

```ts
import AWS from "alchemy/aws/control";

const advancedList = await AWS.FraudDetector.List("advanced-list", {
  Name: "list-",
  Tags: {
    Environment: "production",
    Team: "DevOps",
    Project: "MyApp",
    CostCenter: "Engineering",
    ManagedBy: "Alchemy",
  },
  Description: "A list resource managed by Alchemy",
});
```

