---
title: Managing AWS EC2 VPCBlockPublicAccessOptionss with Alchemy
description: Learn how to create, update, and manage AWS EC2 VPCBlockPublicAccessOptionss using Alchemy Cloud Control.
---

# VPCBlockPublicAccessOptions

The VPCBlockPublicAccessOptions resource lets you create and manage [AWS EC2 VPCBlockPublicAccessOptionss](https://docs.aws.amazon.com/ec2/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-ec2-vpcblockpublicaccessoptions.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const vpcblockpublicaccessoptions = await AWS.EC2.VPCBlockPublicAccessOptions(
  "vpcblockpublicaccessoptions-example",
  { InternetGatewayBlockMode: "example-internetgatewayblockmode" }
);
```

