---
title: Managing AWS Elasticsearch Domains with Alchemy
description: Learn how to create, update, and manage AWS Elasticsearch Domains using Alchemy Cloud Control.
---

# Domain

The Domain resource lets you create and manage [AWS Elasticsearch Domains](https://docs.aws.amazon.com/elasticsearch/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-elasticsearch-domain.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const domain = await AWS.Elasticsearch.Domain("domain-example", {
  Tags: { Environment: "production", ManagedBy: "Alchemy" },
});
```

## Advanced Configuration

Create a domain with additional configuration:

```ts
import AWS from "alchemy/aws/control";

const advancedDomain = await AWS.Elasticsearch.Domain("advanced-domain", {
  Tags: {
    Environment: "production",
    Team: "DevOps",
    Project: "MyApp",
    CostCenter: "Engineering",
    ManagedBy: "Alchemy",
  },
});
```

