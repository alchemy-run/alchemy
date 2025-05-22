---
title: Managing AWS ECR Repositorys with Alchemy
description: Learn how to create, update, and manage AWS ECR Repositorys using Alchemy Cloud Control.
---

# Repository

The Repository resource lets you create and manage [AWS ECR Repositorys](https://docs.aws.amazon.com/ecr/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-ecr-repository.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const repository = await AWS.ECR.Repository("repository-example", {
  Tags: { Environment: "production", ManagedBy: "Alchemy" },
});
```

## Advanced Configuration

Create a repository with additional configuration:

```ts
import AWS from "alchemy/aws/control";

const advancedRepository = await AWS.ECR.Repository("advanced-repository", {
  Tags: {
    Environment: "production",
    Team: "DevOps",
    Project: "MyApp",
    CostCenter: "Engineering",
    ManagedBy: "Alchemy",
  },
});
```

