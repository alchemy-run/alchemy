---
title: Managing AWS OpenSearchService Domains with Alchemy
description: Learn how to create, update, and manage AWS OpenSearchService Domains using Alchemy Cloud Control.
---

# Domain

The Domain resource lets you create and manage [AWS OpenSearchService Domains](https://docs.aws.amazon.com/opensearchservice/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-opensearchservice-domain.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const domain = await AWS.OpenSearchService.Domain("domain-example", {
  Tags: { Environment: "production", ManagedBy: "Alchemy" },
});
```

## Advanced Configuration

Create a domain with additional configuration:

```ts
import AWS from "alchemy/aws/control";

const advancedDomain = await AWS.OpenSearchService.Domain("advanced-domain", {
  Tags: {
    Environment: "production",
    Team: "DevOps",
    Project: "MyApp",
    CostCenter: "Engineering",
    ManagedBy: "Alchemy",
  },
});
```

