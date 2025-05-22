---
title: Managing AWS CodeArtifact Domains with Alchemy
description: Learn how to create, update, and manage AWS CodeArtifact Domains using Alchemy Cloud Control.
---

# Domain

The Domain resource lets you create and manage [AWS CodeArtifact Domains](https://docs.aws.amazon.com/codeartifact/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-codeartifact-domain.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const domain = await AWS.CodeArtifact.Domain("domain-example", {
  DomainName: "domain-domain",
  Tags: { Environment: "production", ManagedBy: "Alchemy" },
});
```

## Advanced Configuration

Create a domain with additional configuration:

```ts
import AWS from "alchemy/aws/control";

const advancedDomain = await AWS.CodeArtifact.Domain("advanced-domain", {
  DomainName: "domain-domain",
  Tags: {
    Environment: "production",
    Team: "DevOps",
    Project: "MyApp",
    CostCenter: "Engineering",
    ManagedBy: "Alchemy",
  },
});
```

