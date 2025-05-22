---
title: Managing AWS IVS IngestConfigurations with Alchemy
description: Learn how to create, update, and manage AWS IVS IngestConfigurations using Alchemy Cloud Control.
---

# IngestConfiguration

The IngestConfiguration resource lets you create and manage [AWS IVS IngestConfigurations](https://docs.aws.amazon.com/ivs/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-ivs-ingestconfiguration.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const ingestconfiguration = await AWS.IVS.IngestConfiguration("ingestconfiguration-example", {
  Tags: { Environment: "production", ManagedBy: "Alchemy" },
});
```

## Advanced Configuration

Create a ingestconfiguration with additional configuration:

```ts
import AWS from "alchemy/aws/control";

const advancedIngestConfiguration = await AWS.IVS.IngestConfiguration(
  "advanced-ingestconfiguration",
  {
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

