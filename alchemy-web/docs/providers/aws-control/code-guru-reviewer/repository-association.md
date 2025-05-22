---
title: Managing AWS CodeGuruReviewer RepositoryAssociations with Alchemy
description: Learn how to create, update, and manage AWS CodeGuruReviewer RepositoryAssociations using Alchemy Cloud Control.
---

# RepositoryAssociation

The RepositoryAssociation resource lets you create and manage [AWS CodeGuruReviewer RepositoryAssociations](https://docs.aws.amazon.com/codegurureviewer/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-codegurureviewer-repositoryassociation.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const repositoryassociation = await AWS.CodeGuruReviewer.RepositoryAssociation(
  "repositoryassociation-example",
  {
    Type: "example-type",
    Name: "repositoryassociation-",
    Tags: { Environment: "production", ManagedBy: "Alchemy" },
  }
);
```

## Advanced Configuration

Create a repositoryassociation with additional configuration:

```ts
import AWS from "alchemy/aws/control";

const advancedRepositoryAssociation = await AWS.CodeGuruReviewer.RepositoryAssociation(
  "advanced-repositoryassociation",
  {
    Type: "example-type",
    Name: "repositoryassociation-",
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

