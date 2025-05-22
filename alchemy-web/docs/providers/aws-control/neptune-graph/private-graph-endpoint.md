---
title: Managing AWS NeptuneGraph PrivateGraphEndpoints with Alchemy
description: Learn how to create, update, and manage AWS NeptuneGraph PrivateGraphEndpoints using Alchemy Cloud Control.
---

# PrivateGraphEndpoint

The PrivateGraphEndpoint resource lets you create and manage [AWS NeptuneGraph PrivateGraphEndpoints](https://docs.aws.amazon.com/neptunegraph/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-neptunegraph-privategraphendpoint.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const privategraphendpoint = await AWS.NeptuneGraph.PrivateGraphEndpoint(
  "privategraphendpoint-example",
  { VpcId: "example-vpcid", GraphIdentifier: "example-graphidentifier" }
);
```

