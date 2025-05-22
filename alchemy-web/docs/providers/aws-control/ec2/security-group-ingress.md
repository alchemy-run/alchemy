---
title: Managing AWS EC2 SecurityGroupIngresss with Alchemy
description: Learn how to create, update, and manage AWS EC2 SecurityGroupIngresss using Alchemy Cloud Control.
---

# SecurityGroupIngress

The SecurityGroupIngress resource lets you create and manage [AWS EC2 SecurityGroupIngresss](https://docs.aws.amazon.com/ec2/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-ec2-securitygroupingress.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const securitygroupingress = await AWS.EC2.SecurityGroupIngress("securitygroupingress-example", {
  IpProtocol: "example-ipprotocol",
  Description: "A securitygroupingress resource managed by Alchemy",
});
```

## Advanced Configuration

Create a securitygroupingress with additional configuration:

```ts
import AWS from "alchemy/aws/control";

const advancedSecurityGroupIngress = await AWS.EC2.SecurityGroupIngress(
  "advanced-securitygroupingress",
  {
    IpProtocol: "example-ipprotocol",
    Description: "A securitygroupingress resource managed by Alchemy",
  }
);
```

