---
title: Managing AWS EC2 SecurityGroupEgresss with Alchemy
description: Learn how to create, update, and manage AWS EC2 SecurityGroupEgresss using Alchemy Cloud Control.
---

# SecurityGroupEgress

The SecurityGroupEgress resource lets you create and manage [AWS EC2 SecurityGroupEgresss](https://docs.aws.amazon.com/ec2/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-ec2-securitygroupegress.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const securitygroupegress = await AWS.EC2.SecurityGroupEgress("securitygroupegress-example", {
  IpProtocol: "example-ipprotocol",
  GroupId: "example-groupid",
  Description: "A securitygroupegress resource managed by Alchemy",
});
```

## Advanced Configuration

Create a securitygroupegress with additional configuration:

```ts
import AWS from "alchemy/aws/control";

const advancedSecurityGroupEgress = await AWS.EC2.SecurityGroupEgress(
  "advanced-securitygroupegress",
  {
    IpProtocol: "example-ipprotocol",
    GroupId: "example-groupid",
    Description: "A securitygroupegress resource managed by Alchemy",
  }
);
```

