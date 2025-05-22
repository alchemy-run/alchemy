---
title: Managing AWS ServiceCatalog PortfolioShares with Alchemy
description: Learn how to create, update, and manage AWS ServiceCatalog PortfolioShares using Alchemy Cloud Control.
---

# PortfolioShare

The PortfolioShare resource lets you create and manage [AWS ServiceCatalog PortfolioShares](https://docs.aws.amazon.com/servicecatalog/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-servicecatalog-portfolioshare.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const portfolioshare = await AWS.ServiceCatalog.PortfolioShare("portfolioshare-example", {
  AccountId: "example-accountid",
  PortfolioId: "example-portfolioid",
});
```

