---
title: Managing AWS ServiceCatalog PortfolioProductAssociations with Alchemy
description: Learn how to create, update, and manage AWS ServiceCatalog PortfolioProductAssociations using Alchemy Cloud Control.
---

# PortfolioProductAssociation

The PortfolioProductAssociation resource lets you create and manage [AWS ServiceCatalog PortfolioProductAssociations](https://docs.aws.amazon.com/servicecatalog/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-servicecatalog-portfolioproductassociation.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const portfolioproductassociation = await AWS.ServiceCatalog.PortfolioProductAssociation(
  "portfolioproductassociation-example",
  { PortfolioId: "example-portfolioid", ProductId: "example-productid" }
);
```

