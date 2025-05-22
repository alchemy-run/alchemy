---
title: Managing AWS RDS DBProxyEndpoints with Alchemy
description: Learn how to create, update, and manage AWS RDS DBProxyEndpoints using Alchemy Cloud Control.
---

# DBProxyEndpoint

The DBProxyEndpoint resource lets you create and manage [AWS RDS DBProxyEndpoints](https://docs.aws.amazon.com/rds/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-rds-dbproxyendpoint.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const dbproxyendpoint = await AWS.RDS.DBProxyEndpoint("dbproxyendpoint-example", {
  DBProxyEndpointName: "dbproxyendpoint-dbproxyendpoint",
  DBProxyName: "dbproxyendpoint-dbproxy",
  VpcSubnetIds: ["example-vpcsubnetids-1"],
  Tags: { Environment: "production", ManagedBy: "Alchemy" },
});
```

## Advanced Configuration

Create a dbproxyendpoint with additional configuration:

```ts
import AWS from "alchemy/aws/control";

const advancedDBProxyEndpoint = await AWS.RDS.DBProxyEndpoint("advanced-dbproxyendpoint", {
  DBProxyEndpointName: "dbproxyendpoint-dbproxyendpoint",
  DBProxyName: "dbproxyendpoint-dbproxy",
  VpcSubnetIds: ["example-vpcsubnetids-1"],
  Tags: {
    Environment: "production",
    Team: "DevOps",
    Project: "MyApp",
    CostCenter: "Engineering",
    ManagedBy: "Alchemy",
  },
});
```

