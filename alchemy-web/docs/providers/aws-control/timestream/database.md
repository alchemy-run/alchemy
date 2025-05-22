---
title: Managing AWS Timestream Databases with Alchemy
description: Learn how to create, update, and manage AWS Timestream Databases using Alchemy Cloud Control.
---

# Database

The Database resource lets you create and manage [AWS Timestream Databases](https://docs.aws.amazon.com/timestream/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-timestream-database.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const database = await AWS.Timestream.Database("database-example", {
  Tags: { Environment: "production", ManagedBy: "Alchemy" },
});
```

## Advanced Configuration

Create a database with additional configuration:

```ts
import AWS from "alchemy/aws/control";

const advancedDatabase = await AWS.Timestream.Database("advanced-database", {
  Tags: {
    Environment: "production",
    Team: "DevOps",
    Project: "MyApp",
    CostCenter: "Engineering",
    ManagedBy: "Alchemy",
  },
});
```

