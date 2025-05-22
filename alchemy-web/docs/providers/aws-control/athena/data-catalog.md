---
title: Managing AWS Athena DataCatalogs with Alchemy
description: Learn how to create, update, and manage AWS Athena DataCatalogs using Alchemy Cloud Control.
---

# DataCatalog

The DataCatalog resource lets you create and manage [AWS Athena DataCatalogs](https://docs.aws.amazon.com/athena/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-athena-datacatalog.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const datacatalog = await AWS.Athena.DataCatalog("datacatalog-example", {
  Type: "example-type",
  Name: "datacatalog-",
  Tags: { Environment: "production", ManagedBy: "Alchemy" },
  Description: "A datacatalog resource managed by Alchemy",
});
```

## Advanced Configuration

Create a datacatalog with additional configuration:

```ts
import AWS from "alchemy/aws/control";

const advancedDataCatalog = await AWS.Athena.DataCatalog("advanced-datacatalog", {
  Type: "example-type",
  Name: "datacatalog-",
  Tags: {
    Environment: "production",
    Team: "DevOps",
    Project: "MyApp",
    CostCenter: "Engineering",
    ManagedBy: "Alchemy",
  },
  Description: "A datacatalog resource managed by Alchemy",
});
```

