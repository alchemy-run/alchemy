---
title: Managing AWS ServiceCatalog LaunchNotificationConstraints with Alchemy
description: Learn how to create, update, and manage AWS ServiceCatalog LaunchNotificationConstraints using Alchemy Cloud Control.
---

# LaunchNotificationConstraint

The LaunchNotificationConstraint resource lets you create and manage [AWS ServiceCatalog LaunchNotificationConstraints](https://docs.aws.amazon.com/servicecatalog/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-servicecatalog-launchnotificationconstraint.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const launchnotificationconstraint = await AWS.ServiceCatalog.LaunchNotificationConstraint(
  "launchnotificationconstraint-example",
  {
    NotificationArns: ["example-notificationarns-1"],
    PortfolioId: "example-portfolioid",
    ProductId: "example-productid",
    Description: "A launchnotificationconstraint resource managed by Alchemy",
  }
);
```

## Advanced Configuration

Create a launchnotificationconstraint with additional configuration:

```ts
import AWS from "alchemy/aws/control";

const advancedLaunchNotificationConstraint = await AWS.ServiceCatalog.LaunchNotificationConstraint(
  "advanced-launchnotificationconstraint",
  {
    NotificationArns: ["example-notificationarns-1"],
    PortfolioId: "example-portfolioid",
    ProductId: "example-productid",
    Description: "A launchnotificationconstraint resource managed by Alchemy",
  }
);
```

