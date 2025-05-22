---
title: Managing AWS EC2 TrafficMirrorFilters with Alchemy
description: Learn how to create, update, and manage AWS EC2 TrafficMirrorFilters using Alchemy Cloud Control.
---

# TrafficMirrorFilter

The TrafficMirrorFilter resource lets you create and manage [AWS EC2 TrafficMirrorFilters](https://docs.aws.amazon.com/ec2/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-ec2-trafficmirrorfilter.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const trafficmirrorfilter = await AWS.EC2.TrafficMirrorFilter("trafficmirrorfilter-example", {
  Tags: { Environment: "production", ManagedBy: "Alchemy" },
  Description: "A trafficmirrorfilter resource managed by Alchemy",
});
```

## Advanced Configuration

Create a trafficmirrorfilter with additional configuration:

```ts
import AWS from "alchemy/aws/control";

const advancedTrafficMirrorFilter = await AWS.EC2.TrafficMirrorFilter(
  "advanced-trafficmirrorfilter",
  {
    Tags: {
      Environment: "production",
      Team: "DevOps",
      Project: "MyApp",
      CostCenter: "Engineering",
      ManagedBy: "Alchemy",
    },
    Description: "A trafficmirrorfilter resource managed by Alchemy",
  }
);
```

