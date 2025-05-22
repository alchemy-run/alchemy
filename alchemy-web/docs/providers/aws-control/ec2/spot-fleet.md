---
title: Managing AWS EC2 SpotFleets with Alchemy
description: Learn how to create, update, and manage AWS EC2 SpotFleets using Alchemy Cloud Control.
---

# SpotFleet

The SpotFleet resource lets you create and manage [AWS EC2 SpotFleets](https://docs.aws.amazon.com/ec2/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-ec2-spotfleet.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const spotfleet = await AWS.EC2.SpotFleet("spotfleet-example", {
  SpotFleetRequestConfigData: "example-spotfleetrequestconfigdata",
});
```

