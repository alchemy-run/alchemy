---
title: Managing AWS ServiceCatalog LaunchRoleConstraints with Alchemy
description: Learn how to create, update, and manage AWS ServiceCatalog LaunchRoleConstraints using Alchemy Cloud Control.
---

# LaunchRoleConstraint

The LaunchRoleConstraint resource lets you create and manage [AWS ServiceCatalog LaunchRoleConstraints](https://docs.aws.amazon.com/servicecatalog/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-servicecatalog-launchroleconstraint.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const launchroleconstraint = await AWS.ServiceCatalog.LaunchRoleConstraint(
  "launchroleconstraint-example",
  {
    PortfolioId: "example-portfolioid",
    ProductId: "example-productid",
    Description: "A launchroleconstraint resource managed by Alchemy",
  }
);
```

## Advanced Configuration

Create a launchroleconstraint with additional configuration:

```ts
import AWS from "alchemy/aws/control";

const advancedLaunchRoleConstraint = await AWS.ServiceCatalog.LaunchRoleConstraint(
  "advanced-launchroleconstraint",
  {
    PortfolioId: "example-portfolioid",
    ProductId: "example-productid",
    Description: "A launchroleconstraint resource managed by Alchemy",
  }
);
```

