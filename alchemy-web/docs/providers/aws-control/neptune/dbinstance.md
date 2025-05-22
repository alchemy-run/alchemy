---
title: Managing AWS Neptune DBInstances with Alchemy
description: Learn how to create, update, and manage AWS Neptune DBInstances using Alchemy Cloud Control.
---

# DBInstance

The DBInstance resource lets you create and manage [AWS Neptune DBInstances](https://docs.aws.amazon.com/neptune/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-neptune-dbinstance.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const dbinstance = await AWS.Neptune.DBInstance("dbinstance-example", {
  DBInstanceClass: "example-dbinstanceclass",
  Tags: { Environment: "production", ManagedBy: "Alchemy" },
});
```

## Advanced Configuration

Create a dbinstance with additional configuration:

```ts
import AWS from "alchemy/aws/control";

const advancedDBInstance = await AWS.Neptune.DBInstance("advanced-dbinstance", {
  DBInstanceClass: "example-dbinstanceclass",
  Tags: {
    Environment: "production",
    Team: "DevOps",
    Project: "MyApp",
    CostCenter: "Engineering",
    ManagedBy: "Alchemy",
  },
});
```

