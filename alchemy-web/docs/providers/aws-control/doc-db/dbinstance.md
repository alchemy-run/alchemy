---
title: Managing AWS DocDB DBInstances with Alchemy
description: Learn how to create, update, and manage AWS DocDB DBInstances using Alchemy Cloud Control.
---

# DBInstance

The DBInstance resource lets you create and manage [AWS DocDB DBInstances](https://docs.aws.amazon.com/docdb/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-docdb-dbinstance.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const dbinstance = await AWS.DocDB.DBInstance("dbinstance-example", {
  DBInstanceClass: "example-dbinstanceclass",
  DBClusterIdentifier: "example-dbclusteridentifier",
  Tags: { Environment: "production", ManagedBy: "Alchemy" },
});
```

## Advanced Configuration

Create a dbinstance with additional configuration:

```ts
import AWS from "alchemy/aws/control";

const advancedDBInstance = await AWS.DocDB.DBInstance("advanced-dbinstance", {
  DBInstanceClass: "example-dbinstanceclass",
  DBClusterIdentifier: "example-dbclusteridentifier",
  Tags: {
    Environment: "production",
    Team: "DevOps",
    Project: "MyApp",
    CostCenter: "Engineering",
    ManagedBy: "Alchemy",
  },
});
```

