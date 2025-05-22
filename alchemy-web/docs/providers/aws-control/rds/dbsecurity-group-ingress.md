---
title: Managing AWS RDS DBSecurityGroupIngresss with Alchemy
description: Learn how to create, update, and manage AWS RDS DBSecurityGroupIngresss using Alchemy Cloud Control.
---

# DBSecurityGroupIngress

The DBSecurityGroupIngress resource lets you create and manage [AWS RDS DBSecurityGroupIngresss](https://docs.aws.amazon.com/rds/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-rds-security-group-ingress.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const dbsecuritygroupingress = await AWS.RDS.DBSecurityGroupIngress(
  "dbsecuritygroupingress-example",
  { DBSecurityGroupName: "dbsecuritygroupingress-dbsecuritygroup" }
);
```

