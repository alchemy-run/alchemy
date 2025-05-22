---
title: Managing AWS XRay TransactionSearchConfigs with Alchemy
description: Learn how to create, update, and manage AWS XRay TransactionSearchConfigs using Alchemy Cloud Control.
---

# TransactionSearchConfig

The TransactionSearchConfig resource lets you create and manage [AWS XRay TransactionSearchConfigs](https://docs.aws.amazon.com/xray/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-xray-transactionsearchconfig.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const transactionsearchconfig = await AWS.XRay.TransactionSearchConfig(
  "transactionsearchconfig-example",
  {}
);
```

