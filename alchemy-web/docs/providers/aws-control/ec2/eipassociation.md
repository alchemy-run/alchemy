---
title: Managing AWS EC2 EIPAssociations with Alchemy
description: Learn how to create, update, and manage AWS EC2 EIPAssociations using Alchemy Cloud Control.
---

# EIPAssociation

The EIPAssociation resource lets you create and manage [AWS EC2 EIPAssociations](https://docs.aws.amazon.com/ec2/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-ec2-eipassociation.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const eipassociation = await AWS.EC2.EIPAssociation("eipassociation-example", {});
```

