---
title: Managing AWS CloudFormation Publishers with Alchemy
description: Learn how to create, update, and manage AWS CloudFormation Publishers using Alchemy Cloud Control.
---

# Publisher

The Publisher resource lets you create and manage [AWS CloudFormation Publishers](https://docs.aws.amazon.com/cloudformation/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-cloudformation-publisher.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const publisher = await AWS.CloudFormation.Publisher("publisher-example", {
  AcceptTermsAndConditions: true,
});
```

