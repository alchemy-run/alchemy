---
title: Managing AWS CloudFormation TypeActivations with Alchemy
description: Learn how to create, update, and manage AWS CloudFormation TypeActivations using Alchemy Cloud Control.
---

# TypeActivation

The TypeActivation resource lets you create and manage [AWS CloudFormation TypeActivations](https://docs.aws.amazon.com/cloudformation/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-cloudformation-typeactivation.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const typeactivation = await AWS.CloudFormation.TypeActivation("typeactivation-example", {});
```

