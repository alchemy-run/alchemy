---
title: Managing AWS EC2 ClientVpnAuthorizationRules with Alchemy
description: Learn how to create, update, and manage AWS EC2 ClientVpnAuthorizationRules using Alchemy Cloud Control.
---

# ClientVpnAuthorizationRule

The ClientVpnAuthorizationRule resource lets you create and manage [AWS EC2 ClientVpnAuthorizationRules](https://docs.aws.amazon.com/ec2/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-ec2-clientvpnauthorizationrule.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const clientvpnauthorizationrule = await AWS.EC2.ClientVpnAuthorizationRule(
  "clientvpnauthorizationrule-example",
  {
    ClientVpnEndpointId: "example-clientvpnendpointid",
    TargetNetworkCidr: "example-targetnetworkcidr",
    Description: "A clientvpnauthorizationrule resource managed by Alchemy",
  }
);
```

## Advanced Configuration

Create a clientvpnauthorizationrule with additional configuration:

```ts
import AWS from "alchemy/aws/control";

const advancedClientVpnAuthorizationRule = await AWS.EC2.ClientVpnAuthorizationRule(
  "advanced-clientvpnauthorizationrule",
  {
    ClientVpnEndpointId: "example-clientvpnendpointid",
    TargetNetworkCidr: "example-targetnetworkcidr",
    Description: "A clientvpnauthorizationrule resource managed by Alchemy",
  }
);
```

