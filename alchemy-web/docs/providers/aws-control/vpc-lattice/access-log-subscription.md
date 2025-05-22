---
title: Managing AWS VpcLattice AccessLogSubscriptions with Alchemy
description: Learn how to create, update, and manage AWS VpcLattice AccessLogSubscriptions using Alchemy Cloud Control.
---

# AccessLogSubscription

The AccessLogSubscription resource lets you create and manage [AWS VpcLattice AccessLogSubscriptions](https://docs.aws.amazon.com/vpclattice/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-vpclattice-accesslogsubscription.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const accesslogsubscription = await AWS.VpcLattice.AccessLogSubscription(
  "accesslogsubscription-example",
  {
    DestinationArn: "example-destinationarn",
    Tags: { Environment: "production", ManagedBy: "Alchemy" },
  }
);
```

## Advanced Configuration

Create a accesslogsubscription with additional configuration:

```ts
import AWS from "alchemy/aws/control";

const advancedAccessLogSubscription = await AWS.VpcLattice.AccessLogSubscription(
  "advanced-accesslogsubscription",
  {
    DestinationArn: "example-destinationarn",
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

