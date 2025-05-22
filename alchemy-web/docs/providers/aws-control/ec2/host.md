---
title: Managing AWS EC2 Hosts with Alchemy
description: Learn how to create, update, and manage AWS EC2 Hosts using Alchemy Cloud Control.
---

# Host

The Host resource lets you create and manage [AWS EC2 Hosts](https://docs.aws.amazon.com/ec2/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-ec2-host.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const host = await AWS.EC2.Host("host-example", { AvailabilityZone: "example-availabilityzone" });
```

