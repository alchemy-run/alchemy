---
title: Managing AWS RDS DBProxyTargetGroups with Alchemy
description: Learn how to create, update, and manage AWS RDS DBProxyTargetGroups using Alchemy Cloud Control.
---

# DBProxyTargetGroup

The DBProxyTargetGroup resource lets you create and manage [AWS RDS DBProxyTargetGroups](https://docs.aws.amazon.com/rds/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-rds-dbproxytargetgroup.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const dbproxytargetgroup = await AWS.RDS.DBProxyTargetGroup("dbproxytargetgroup-example", {
  DBProxyName: "dbproxytargetgroup-dbproxy",
  TargetGroupName: "dbproxytargetgroup-targetgroup",
});
```

