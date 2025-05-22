---
title: Managing AWS EC2 VPCEndpointConnectionNotifications with Alchemy
description: Learn how to create, update, and manage AWS EC2 VPCEndpointConnectionNotifications using Alchemy Cloud Control.
---

# VPCEndpointConnectionNotification

The VPCEndpointConnectionNotification resource lets you create and manage [AWS EC2 VPCEndpointConnectionNotifications](https://docs.aws.amazon.com/ec2/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-ec2-vpcendpointconnectionnotification.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const vpcendpointconnectionnotification = await AWS.EC2.VPCEndpointConnectionNotification(
  "vpcendpointconnectionnotification-example",
  {
    ConnectionEvents: ["example-connectionevents-1"],
    ConnectionNotificationArn: "example-connectionnotificationarn",
  }
);
```

