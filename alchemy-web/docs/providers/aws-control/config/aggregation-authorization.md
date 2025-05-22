---
title: Managing AWS Config AggregationAuthorizations with Alchemy
description: Learn how to create, update, and manage AWS Config AggregationAuthorizations using Alchemy Cloud Control.
---

# AggregationAuthorization

The AggregationAuthorization resource lets you create and manage [AWS Config AggregationAuthorizations](https://docs.aws.amazon.com/config/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-config-aggregationauthorization.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const aggregationauthorization = await AWS.Config.AggregationAuthorization(
  "aggregationauthorization-example",
  {
    AuthorizedAccountId: "example-authorizedaccountid",
    AuthorizedAwsRegion: "example-authorizedawsregion",
    Tags: { Environment: "production", ManagedBy: "Alchemy" },
  }
);
```

## Advanced Configuration

Create a aggregationauthorization with additional configuration:

```ts
import AWS from "alchemy/aws/control";

const advancedAggregationAuthorization = await AWS.Config.AggregationAuthorization(
  "advanced-aggregationauthorization",
  {
    AuthorizedAccountId: "example-authorizedaccountid",
    AuthorizedAwsRegion: "example-authorizedawsregion",
    Tags: {
      Environment: "production",
      Team: "DevOps",
      Project: "MyApp",
      CostCenter: "Engineering",
      ManagedBy: "Alchemy",
    },
  }
);
```

