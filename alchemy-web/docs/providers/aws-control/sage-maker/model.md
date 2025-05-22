---
title: Managing AWS SageMaker Models with Alchemy
description: Learn how to create, update, and manage AWS SageMaker Models using Alchemy Cloud Control.
---

# Model

The Model resource lets you create and manage [AWS SageMaker Models](https://docs.aws.amazon.com/sagemaker/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-sagemaker-model.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const model = await AWS.SageMaker.Model("model-example", {
  Tags: { Environment: "production", ManagedBy: "Alchemy" },
});
```

## Advanced Configuration

Create a model with additional configuration:

```ts
import AWS from "alchemy/aws/control";

const advancedModel = await AWS.SageMaker.Model("advanced-model", {
  Tags: {
    Environment: "production",
    Team: "DevOps",
    Project: "MyApp",
    CostCenter: "Engineering",
    ManagedBy: "Alchemy",
  },
});
```

