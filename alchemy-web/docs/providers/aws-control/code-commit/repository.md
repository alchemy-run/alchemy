---
title: Managing AWS CodeCommit Repositorys with Alchemy
description: Learn how to create, update, and manage AWS CodeCommit Repositorys using Alchemy Cloud Control.
---

# Repository

The Repository resource lets you create and manage [AWS CodeCommit Repositorys](https://docs.aws.amazon.com/codecommit/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-codecommit-repository.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const repository = await AWS.CodeCommit.Repository("repository-example", {
  RepositoryName: "repository-repository",
  Tags: { Environment: "production", ManagedBy: "Alchemy" },
});
```

## Advanced Configuration

Create a repository with additional configuration:

```ts
import AWS from "alchemy/aws/control";

const advancedRepository = await AWS.CodeCommit.Repository("advanced-repository", {
  RepositoryName: "repository-repository",
  Tags: {
    Environment: "production",
    Team: "DevOps",
    Project: "MyApp",
    CostCenter: "Engineering",
    ManagedBy: "Alchemy",
  },
});
```

