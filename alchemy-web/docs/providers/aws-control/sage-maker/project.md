---
title: Managing AWS SageMaker Projects with Alchemy
description: Learn how to create, update, and manage AWS SageMaker Projects using Alchemy Cloud Control.
---

# Project

The Project resource lets you create and manage [AWS SageMaker Projects](https://docs.aws.amazon.com/sagemaker/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-sagemaker-project.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const project = await AWS.SageMaker.Project("project-example", {
  ProjectName: "project-project",
  ServiceCatalogProvisioningDetails: "example-servicecatalogprovisioningdetails",
  Tags: { Environment: "production", ManagedBy: "Alchemy" },
});
```

## Advanced Configuration

Create a project with additional configuration:

```ts
import AWS from "alchemy/aws/control";

const advancedProject = await AWS.SageMaker.Project("advanced-project", {
  ProjectName: "project-project",
  ServiceCatalogProvisioningDetails: "example-servicecatalogprovisioningdetails",
  Tags: {
    Environment: "production",
    Team: "DevOps",
    Project: "MyApp",
    CostCenter: "Engineering",
    ManagedBy: "Alchemy",
  },
});
```

