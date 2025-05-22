---
title: Managing AWS Route53 HealthChecks with Alchemy
description: Learn how to create, update, and manage AWS Route53 HealthChecks using Alchemy Cloud Control.
---

# HealthCheck

The HealthCheck resource lets you create and manage [AWS Route53 HealthChecks](https://docs.aws.amazon.com/route53/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-route53-healthcheck.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const healthcheck = await AWS.Route53.HealthCheck("healthcheck-example", {
  HealthCheckConfig: "example-healthcheckconfig",
});
```

