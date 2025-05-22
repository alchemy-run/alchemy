---
title: Managing AWS ApiGateway BasePathMappings with Alchemy
description: Learn how to create, update, and manage AWS ApiGateway BasePathMappings using Alchemy Cloud Control.
---

# BasePathMapping

The BasePathMapping resource lets you create and manage [AWS ApiGateway BasePathMappings](https://docs.aws.amazon.com/apigateway/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-apigateway-basepathmapping.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const basepathmapping = await AWS.ApiGateway.BasePathMapping("basepathmapping-example", {
  DomainName: "basepathmapping-domain",
});
```

