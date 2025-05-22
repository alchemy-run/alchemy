---
title: Managing AWS SageMaker ModelPackageGroups with Alchemy
description: Learn how to create, update, and manage AWS SageMaker ModelPackageGroups using Alchemy Cloud Control.
---

# ModelPackageGroup

The ModelPackageGroup resource lets you create and manage [AWS SageMaker ModelPackageGroups](https://docs.aws.amazon.com/sagemaker/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-sagemaker-modelpackagegroup.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const modelpackagegroup = await AWS.SageMaker.ModelPackageGroup("modelpackagegroup-example", {
  ModelPackageGroupName: "modelpackagegroup-modelpackagegroup",
  Tags: { Environment: "production", ManagedBy: "Alchemy" },
});
```

## Advanced Configuration

Create a modelpackagegroup with additional configuration:

```ts
import AWS from "alchemy/aws/control";

const advancedModelPackageGroup = await AWS.SageMaker.ModelPackageGroup(
  "advanced-modelpackagegroup",
  {
    ModelPackageGroupName: "modelpackagegroup-modelpackagegroup",
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

