---
title: Managing AWS EC2 IPAMPoolCidrs with Alchemy
description: Learn how to create, update, and manage AWS EC2 IPAMPoolCidrs using Alchemy Cloud Control.
---

# IPAMPoolCidr

The IPAMPoolCidr resource lets you create and manage [AWS EC2 IPAMPoolCidrs](https://docs.aws.amazon.com/ec2/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-ec2-ipampoolcidr.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const ipampoolcidr = await AWS.EC2.IPAMPoolCidr("ipampoolcidr-example", {
  IpamPoolId: "example-ipampoolid",
});
```

