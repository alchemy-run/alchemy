---
title: Managing AWS ApiGateway DomainNameAccessAssociations with Alchemy
description: Learn how to create, update, and manage AWS ApiGateway DomainNameAccessAssociations using Alchemy Cloud Control.
---

# DomainNameAccessAssociation

The DomainNameAccessAssociation resource lets you create and manage [AWS ApiGateway DomainNameAccessAssociations](https://docs.aws.amazon.com/apigateway/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-apigateway-domainnameaccessassociation.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const domainnameaccessassociation = await AWS.ApiGateway.DomainNameAccessAssociation(
  "domainnameaccessassociation-example",
  {
    DomainNameArn: "domainnameaccessassociation-domainarn",
    AccessAssociationSource: "example-accessassociationsource",
    AccessAssociationSourceType: "example-accessassociationsourcetype",
    Tags: { Environment: "production", ManagedBy: "Alchemy" },
  }
);
```

## Advanced Configuration

Create a domainnameaccessassociation with additional configuration:

```ts
import AWS from "alchemy/aws/control";

const advancedDomainNameAccessAssociation = await AWS.ApiGateway.DomainNameAccessAssociation(
  "advanced-domainnameaccessassociation",
  {
    DomainNameArn: "domainnameaccessassociation-domainarn",
    AccessAssociationSource: "example-accessassociationsource",
    AccessAssociationSourceType: "example-accessassociationsourcetype",
    Tags: {
      Environment: "production",
      Team: "DevOps",
      Project: "MyApp",
      CostCenter: "Engineering",
      ManagedBy: "Alchemy",
    },
  }
);
```

