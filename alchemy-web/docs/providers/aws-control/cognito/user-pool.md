---
title: Managing AWS Cognito UserPools with Alchemy
description: Learn how to create, update, and manage AWS Cognito UserPools using Alchemy Cloud Control.
---

# UserPool

The UserPool resource lets you create and manage [AWS Cognito UserPools](https://docs.aws.amazon.com/cognito/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-cognito-userpool.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const userpool = await AWS.Cognito.UserPool("userpool-example", {});
```

