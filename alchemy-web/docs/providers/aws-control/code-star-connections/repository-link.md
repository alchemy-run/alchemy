---
title: Managing AWS CodeStarConnections RepositoryLinks with Alchemy
description: Learn how to create, update, and manage AWS CodeStarConnections RepositoryLinks using Alchemy Cloud Control.
---

# RepositoryLink

The RepositoryLink resource lets you create and manage [AWS CodeStarConnections RepositoryLinks](https://docs.aws.amazon.com/codestarconnections/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-codestarconnections-repositorylink.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const repositorylink = await AWS.CodeStarConnections.RepositoryLink("repositorylink-example", {
  OwnerId: "example-ownerid",
  ConnectionArn: "example-connectionarn",
  RepositoryName: "repositorylink-repository",
  Tags: { Environment: "production", ManagedBy: "Alchemy" },
});
```

## Advanced Configuration

Create a repositorylink with additional configuration:

```ts
import AWS from "alchemy/aws/control";

const advancedRepositoryLink = await AWS.CodeStarConnections.RepositoryLink(
  "advanced-repositorylink",
  {
    OwnerId: "example-ownerid",
    ConnectionArn: "example-connectionarn",
    RepositoryName: "repositorylink-repository",
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

