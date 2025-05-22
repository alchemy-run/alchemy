---
title: Managing AWS ApiGateway BasePathMappingV2s with Alchemy
description: Learn how to create, update, and manage AWS ApiGateway BasePathMappingV2s using Alchemy Cloud Control.
---

# BasePathMappingV2

The BasePathMappingV2 resource lets you create and manage [AWS ApiGateway BasePathMappingV2s](https://docs.aws.amazon.com/apigateway/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-apigateway-basepathmappingv2.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const basepathmappingv2 = await AWS.ApiGateway.BasePathMappingV2("basepathmappingv2-example", {
  DomainNameArn: "basepathmappingv2-domainarn",
  RestApiId: "example-restapiid",
});
```

