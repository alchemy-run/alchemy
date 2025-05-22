---
title: Managing AWS ElastiCache SecurityGroupIngresss with Alchemy
description: Learn how to create, update, and manage AWS ElastiCache SecurityGroupIngresss using Alchemy Cloud Control.
---

# SecurityGroupIngress

The SecurityGroupIngress resource lets you create and manage [AWS ElastiCache SecurityGroupIngresss](https://docs.aws.amazon.com/elasticache/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-properties-elasticache-security-group-ingress.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const securitygroupingress = await AWS.ElastiCache.SecurityGroupIngress(
  "securitygroupingress-example",
  {
    CacheSecurityGroupName: "securitygroupingress-cachesecuritygroup",
    EC2SecurityGroupName: "securitygroupingress-ec2securitygroup",
  }
);
```

