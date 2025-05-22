---
title: Managing AWS RDS DBProxys with Alchemy
description: Learn how to create, update, and manage AWS RDS DBProxys using Alchemy Cloud Control.
---

# DBProxy

The DBProxy resource lets you create and manage [AWS RDS DBProxys](https://docs.aws.amazon.com/rds/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-rds-dbproxy.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const dbproxy = await AWS.RDS.DBProxy("dbproxy-example", {
  DBProxyName: "dbproxy-dbproxy",
  Auth: [],
  VpcSubnetIds: ["example-vpcsubnetids-1"],
  RoleArn: "example-rolearn",
  EngineFamily: "example-enginefamily",
  Tags: { Environment: "production", ManagedBy: "Alchemy" },
});
```

## Advanced Configuration

Create a dbproxy with additional configuration:

```ts
import AWS from "alchemy/aws/control";

const advancedDBProxy = await AWS.RDS.DBProxy("advanced-dbproxy", {
  DBProxyName: "dbproxy-dbproxy",
  Auth: [],
  VpcSubnetIds: ["example-vpcsubnetids-1"],
  RoleArn: "example-rolearn",
  EngineFamily: "example-enginefamily",
  Tags: {
    Environment: "production",
    Team: "DevOps",
    Project: "MyApp",
    CostCenter: "Engineering",
    ManagedBy: "Alchemy",
  },
});
```

