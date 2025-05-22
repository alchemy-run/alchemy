---
title: Managing AWS QLDB Ledgers with Alchemy
description: Learn how to create, update, and manage AWS QLDB Ledgers using Alchemy Cloud Control.
---

# Ledger

The Ledger resource lets you create and manage [AWS QLDB Ledgers](https://docs.aws.amazon.com/qldb/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-qldb-ledger.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const ledger = await AWS.QLDB.Ledger("ledger-example", {
  PermissionsMode: "example-permissionsmode",
  Tags: { Environment: "production", ManagedBy: "Alchemy" },
});
```

## Advanced Configuration

Create a ledger with additional configuration:

```ts
import AWS from "alchemy/aws/control";

const advancedLedger = await AWS.QLDB.Ledger("advanced-ledger", {
  PermissionsMode: "example-permissionsmode",
  Tags: {
    Environment: "production",
    Team: "DevOps",
    Project: "MyApp",
    CostCenter: "Engineering",
    ManagedBy: "Alchemy",
  },
});
```

