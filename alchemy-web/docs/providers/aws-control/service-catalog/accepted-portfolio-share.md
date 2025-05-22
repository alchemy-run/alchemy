---
title: Managing AWS ServiceCatalog AcceptedPortfolioShares with Alchemy
description: Learn how to create, update, and manage AWS ServiceCatalog AcceptedPortfolioShares using Alchemy Cloud Control.
---

# AcceptedPortfolioShare

The AcceptedPortfolioShare resource lets you create and manage [AWS ServiceCatalog AcceptedPortfolioShares](https://docs.aws.amazon.com/servicecatalog/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-servicecatalog-acceptedportfolioshare.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const acceptedportfolioshare = await AWS.ServiceCatalog.AcceptedPortfolioShare(
  "acceptedportfolioshare-example",
  { PortfolioId: "example-portfolioid" }
);
```

