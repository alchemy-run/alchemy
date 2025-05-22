---
title: Managing AWS ApiGateway DocumentationVersions with Alchemy
description: Learn how to create, update, and manage AWS ApiGateway DocumentationVersions using Alchemy Cloud Control.
---

# DocumentationVersion

The DocumentationVersion resource lets you create and manage [AWS ApiGateway DocumentationVersions](https://docs.aws.amazon.com/apigateway/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-apigateway-documentationversion.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const documentationversion = await AWS.ApiGateway.DocumentationVersion(
  "documentationversion-example",
  {
    DocumentationVersion: "example-documentationversion",
    RestApiId: "example-restapiid",
    Description: "A documentationversion resource managed by Alchemy",
  }
);
```

## Advanced Configuration

Create a documentationversion with additional configuration:

```ts
import AWS from "alchemy/aws/control";

const advancedDocumentationVersion = await AWS.ApiGateway.DocumentationVersion(
  "advanced-documentationversion",
  {
    DocumentationVersion: "example-documentationversion",
    RestApiId: "example-restapiid",
    Description: "A documentationversion resource managed by Alchemy",
  }
);
```

