---
title: Managing AWS Connect TrafficDistributionGroups with Alchemy
description: Learn how to create, update, and manage AWS Connect TrafficDistributionGroups using Alchemy Cloud Control.
---

# TrafficDistributionGroup

The TrafficDistributionGroup resource lets you create and manage [AWS Connect TrafficDistributionGroups](https://docs.aws.amazon.com/connect/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-connect-trafficdistributiongroup.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const trafficdistributiongroup = await AWS.Connect.TrafficDistributionGroup(
  "trafficdistributiongroup-example",
  {
    InstanceArn: "example-instancearn",
    Name: "trafficdistributiongroup-",
    Tags: { Environment: "production", ManagedBy: "Alchemy" },
    Description: "A trafficdistributiongroup resource managed by Alchemy",
  }
);
```

## Advanced Configuration

Create a trafficdistributiongroup with additional configuration:

```ts
import AWS from "alchemy/aws/control";

const advancedTrafficDistributionGroup = await AWS.Connect.TrafficDistributionGroup(
  "advanced-trafficdistributiongroup",
  {
    InstanceArn: "example-instancearn",
    Name: "trafficdistributiongroup-",
    Tags: {
      Environment: "production",
      Team: "DevOps",
      Project: "MyApp",
      CostCenter: "Engineering",
      ManagedBy: "Alchemy",
    },
    Description: "A trafficdistributiongroup resource managed by Alchemy",
  }
);
```

