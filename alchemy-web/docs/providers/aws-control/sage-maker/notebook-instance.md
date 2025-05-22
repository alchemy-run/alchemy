---
title: Managing AWS SageMaker NotebookInstances with Alchemy
description: Learn how to create, update, and manage AWS SageMaker NotebookInstances using Alchemy Cloud Control.
---

# NotebookInstance

The NotebookInstance resource lets you create and manage [AWS SageMaker NotebookInstances](https://docs.aws.amazon.com/sagemaker/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-sagemaker-notebookinstance.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const notebookinstance = await AWS.SageMaker.NotebookInstance("notebookinstance-example", {
  RoleArn: "example-rolearn",
  InstanceType: "example-instancetype",
  Tags: { Environment: "production", ManagedBy: "Alchemy" },
});
```

## Advanced Configuration

Create a notebookinstance with additional configuration:

```ts
import AWS from "alchemy/aws/control";

const advancedNotebookInstance = await AWS.SageMaker.NotebookInstance("advanced-notebookinstance", {
  RoleArn: "example-rolearn",
  InstanceType: "example-instancetype",
  Tags: {
    Environment: "production",
    Team: "DevOps",
    Project: "MyApp",
    CostCenter: "Engineering",
    ManagedBy: "Alchemy",
  },
});
```

