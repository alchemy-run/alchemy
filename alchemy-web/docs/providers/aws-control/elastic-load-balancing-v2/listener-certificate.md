---
title: Managing AWS Application Load Balancer ListenerCertificates with Alchemy
description: Learn how to create, update, and manage AWS Application Load Balancer ListenerCertificates using Alchemy Cloud Control.
---

# ListenerCertificate

The ListenerCertificate resource lets you create and manage [AWS Application Load Balancer ListenerCertificates](https://docs.aws.amazon.com/elasticloadbalancing/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-elasticloadbalancingv2-listenercertificate.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const listenercertificate = await AWS.ElasticLoadBalancingV2.ListenerCertificate(
  "listenercertificate-example",
  { Certificates: [], ListenerArn: "example-listenerarn" }
);
```

