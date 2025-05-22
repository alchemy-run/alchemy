---
title: Managing AWS EC2 CapacityReservations with Alchemy
description: Learn how to create, update, and manage AWS EC2 CapacityReservations using Alchemy Cloud Control.
---

# CapacityReservation

The CapacityReservation resource lets you create and manage [AWS EC2 CapacityReservations](https://docs.aws.amazon.com/ec2/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-ec2-capacityreservation.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const capacityreservation = await AWS.EC2.CapacityReservation("capacityreservation-example", {
  InstanceCount: 1,
  InstancePlatform: "example-instanceplatform",
  InstanceType: "example-instancetype",
});
```

