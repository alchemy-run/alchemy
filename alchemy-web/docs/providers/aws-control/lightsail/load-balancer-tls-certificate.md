---
title: Managing AWS Lightsail LoadBalancerTlsCertificates with Alchemy
description: Learn how to create, update, and manage AWS Lightsail LoadBalancerTlsCertificates using Alchemy Cloud Control.
---

# LoadBalancerTlsCertificate

The LoadBalancerTlsCertificate resource lets you create and manage [AWS Lightsail LoadBalancerTlsCertificates](https://docs.aws.amazon.com/lightsail/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-lightsail-loadbalancertlscertificate.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const loadbalancertlscertificate = await AWS.Lightsail.LoadBalancerTlsCertificate(
  "loadbalancertlscertificate-example",
  {
    LoadBalancerName: "loadbalancertlscertificate-loadbalancer",
    CertificateDomainName: "loadbalancertlscertificate-certificatedomain",
    CertificateName: "loadbalancertlscertificate-certificate",
  }
);
```

