---
title: Managing AWS CodeArtifact Repositorys with Alchemy
description: Learn how to create, update, and manage AWS CodeArtifact Repositorys using Alchemy Cloud Control.
---

# Repository

The Repository resource lets you create and manage [AWS CodeArtifact Repositorys](https://docs.aws.amazon.com/codeartifact/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-codeartifact-repository.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const repository = await AWS.CodeArtifact.Repository("repository-example", {
  DomainName: "repository-domain",
  RepositoryName: "repository-repository",
  Tags: { Environment: "production", ManagedBy: "Alchemy" },
  Description: "A repository resource managed by Alchemy",
});
```

## Advanced Configuration

Create a repository with additional configuration:

```ts
import AWS from "alchemy/aws/control";

const advancedRepository = await AWS.CodeArtifact.Repository("advanced-repository", {
  DomainName: "repository-domain",
  RepositoryName: "repository-repository",
  Tags: {
    Environment: "production",
    Team: "DevOps",
    Project: "MyApp",
    CostCenter: "Engineering",
    ManagedBy: "Alchemy",
  },
  Description: "A repository resource managed by Alchemy",
});
```

