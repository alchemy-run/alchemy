---
title: Managing AWS Redshift ClusterSecurityGroupIngresss with Alchemy
description: Learn how to create, update, and manage AWS Redshift ClusterSecurityGroupIngresss using Alchemy Cloud Control.
---

# ClusterSecurityGroupIngress

The ClusterSecurityGroupIngress resource lets you create and manage [AWS Redshift ClusterSecurityGroupIngresss](https://docs.aws.amazon.com/redshift/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-redshift-clustersecuritygroupingress.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const clustersecuritygroupingress = await AWS.Redshift.ClusterSecurityGroupIngress(
  "clustersecuritygroupingress-example",
  { ClusterSecurityGroupName: "clustersecuritygroupingress-clustersecuritygroup" }
);
```

