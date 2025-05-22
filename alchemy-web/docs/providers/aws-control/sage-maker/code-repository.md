---
title: Managing AWS SageMaker CodeRepositorys with Alchemy
description: Learn how to create, update, and manage AWS SageMaker CodeRepositorys using Alchemy Cloud Control.
---

# CodeRepository

The CodeRepository resource lets you create and manage [AWS SageMaker CodeRepositorys](https://docs.aws.amazon.com/sagemaker/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-sagemaker-coderepository.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const coderepository = await AWS.SageMaker.CodeRepository("coderepository-example", {
  GitConfig: "example-gitconfig",
  Tags: { Environment: "production", ManagedBy: "Alchemy" },
});
```

## Advanced Configuration

Create a coderepository with additional configuration:

```ts
import AWS from "alchemy/aws/control";

const advancedCodeRepository = await AWS.SageMaker.CodeRepository("advanced-coderepository", {
  GitConfig: "example-gitconfig",
  Tags: {
    Environment: "production",
    Team: "DevOps",
    Project: "MyApp",
    CostCenter: "Engineering",
    ManagedBy: "Alchemy",
  },
});
```

