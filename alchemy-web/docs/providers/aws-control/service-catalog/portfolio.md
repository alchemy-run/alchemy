---
title: Managing AWS ServiceCatalog Portfolios with Alchemy
description: Learn how to create, update, and manage AWS ServiceCatalog Portfolios using Alchemy Cloud Control.
---

# Portfolio

The Portfolio resource lets you create and manage [AWS ServiceCatalog Portfolios](https://docs.aws.amazon.com/servicecatalog/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-servicecatalog-portfolio.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const portfolio = await AWS.ServiceCatalog.Portfolio("portfolio-example", {
  ProviderName: "portfolio-provider",
  DisplayName: "portfolio-display",
  Tags: { Environment: "production", ManagedBy: "Alchemy" },
  Description: "A portfolio resource managed by Alchemy",
});
```

## Advanced Configuration

Create a portfolio with additional configuration:

```ts
import AWS from "alchemy/aws/control";

const advancedPortfolio = await AWS.ServiceCatalog.Portfolio("advanced-portfolio", {
  ProviderName: "portfolio-provider",
  DisplayName: "portfolio-display",
  Tags: {
    Environment: "production",
    Team: "DevOps",
    Project: "MyApp",
    CostCenter: "Engineering",
    ManagedBy: "Alchemy",
  },
  Description: "A portfolio resource managed by Alchemy",
});
```

