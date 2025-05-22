---
title: Managing AWS OpenSearchServerless VpcEndpoints with Alchemy
description: Learn how to create, update, and manage AWS OpenSearchServerless VpcEndpoints using Alchemy Cloud Control.
---

# VpcEndpoint

The VpcEndpoint resource lets you create and manage [AWS OpenSearchServerless VpcEndpoints](https://docs.aws.amazon.com/opensearchserverless/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-opensearchserverless-vpcendpoint.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const vpcendpoint = await AWS.OpenSearchServerless.VpcEndpoint("vpcendpoint-example", {
  VpcId: "example-vpcid",
  SubnetIds: ["example-subnetids-1"],
  Name: "vpcendpoint-",
});
```

