---
title: Managing AWS CodeStar GitHubRepositorys with Alchemy
description: Learn how to create, update, and manage AWS CodeStar GitHubRepositorys using Alchemy Cloud Control.
---

# GitHubRepository

The GitHubRepository resource lets you create and manage [AWS CodeStar GitHubRepositorys](https://docs.aws.amazon.com/codestar/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-codestar-githubrepository.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const githubrepository = await AWS.CodeStar.GitHubRepository("githubrepository-example", {
  RepositoryName: "githubrepository-repository",
  RepositoryOwner: "example-repositoryowner",
});
```

