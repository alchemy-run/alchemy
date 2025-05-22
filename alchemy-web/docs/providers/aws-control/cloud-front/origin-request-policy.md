---
title: Managing AWS CloudFront OriginRequestPolicys with Alchemy
description: Learn how to create, update, and manage AWS CloudFront OriginRequestPolicys using Alchemy Cloud Control.
---

# OriginRequestPolicy

The OriginRequestPolicy resource lets you create and manage [AWS CloudFront OriginRequestPolicys](https://docs.aws.amazon.com/cloudfront/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-cloudfront-originrequestpolicy.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const originrequestpolicy = await AWS.CloudFront.OriginRequestPolicy(
  "originrequestpolicy-example",
  { OriginRequestPolicyConfig: "example-originrequestpolicyconfig" }
);
```

