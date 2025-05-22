---
title: Managing AWS EC2 Routes with Alchemy
description: Learn how to create, update, and manage AWS EC2 Routes using Alchemy Cloud Control.
---

# Route

The Route resource lets you create and manage [AWS EC2 Routes](https://docs.aws.amazon.com/ec2/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-ec2-route.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const route = await AWS.EC2.Route("route-example", { RouteTableId: "example-routetableid" });
```

