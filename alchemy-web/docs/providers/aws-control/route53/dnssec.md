---
title: Managing AWS Route53 DNSSECs with Alchemy
description: Learn how to create, update, and manage AWS Route53 DNSSECs using Alchemy Cloud Control.
---

# DNSSEC

The DNSSEC resource lets you create and manage [AWS Route53 DNSSECs](https://docs.aws.amazon.com/route53/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-route53-dnssec.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const dnssec = await AWS.Route53.DNSSEC("dnssec-example", { HostedZoneId: "example-hostedzoneid" });
```

