---
title: Managing AWS ApiGateway ClientCertificates with Alchemy
description: Learn how to create, update, and manage AWS ApiGateway ClientCertificates using Alchemy Cloud Control.
---

# ClientCertificate

The ClientCertificate resource lets you create and manage [AWS ApiGateway ClientCertificates](https://docs.aws.amazon.com/apigateway/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-apigateway-clientcertificate.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const clientcertificate = await AWS.ApiGateway.ClientCertificate("clientcertificate-example", {
  Tags: { Environment: "production", ManagedBy: "Alchemy" },
  Description: "A clientcertificate resource managed by Alchemy",
});
```

## Advanced Configuration

Create a clientcertificate with additional configuration:

```ts
import AWS from "alchemy/aws/control";

const advancedClientCertificate = await AWS.ApiGateway.ClientCertificate(
  "advanced-clientcertificate",
  {
    Tags: {
      Environment: "production",
      Team: "DevOps",
      Project: "MyApp",
      CostCenter: "Engineering",
      ManagedBy: "Alchemy",
    },
    Description: "A clientcertificate resource managed by Alchemy",
  }
);
```

