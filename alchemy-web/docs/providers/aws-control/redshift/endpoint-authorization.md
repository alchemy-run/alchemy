---
title: Managing AWS Redshift EndpointAuthorizations with Alchemy
description: Learn how to create, update, and manage AWS Redshift EndpointAuthorizations using Alchemy Cloud Control.
---

# EndpointAuthorization

The EndpointAuthorization resource lets you create and manage [AWS Redshift EndpointAuthorizations](https://docs.aws.amazon.com/redshift/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-redshift-endpointauthorization.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const endpointauthorization = await AWS.Redshift.EndpointAuthorization(
  "endpointauthorization-example",
  { Account: "example-account", ClusterIdentifier: "example-clusteridentifier" }
);
```

