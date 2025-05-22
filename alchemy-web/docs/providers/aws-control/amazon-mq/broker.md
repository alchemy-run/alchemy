---
title: Managing AWS AmazonMQ Brokers with Alchemy
description: Learn how to create, update, and manage AWS AmazonMQ Brokers using Alchemy Cloud Control.
---

# Broker

The Broker resource lets you create and manage [AWS AmazonMQ Brokers](https://docs.aws.amazon.com/amazonmq/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-amazonmq-broker.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const broker = await AWS.AmazonMQ.Broker("broker-example", {
  HostInstanceType: "example-hostinstancetype",
  Users: [],
  BrokerName: "broker-broker",
  DeploymentMode: "example-deploymentmode",
  EngineType: "example-enginetype",
  PubliclyAccessible: true,
  Tags: { Environment: "production", ManagedBy: "Alchemy" },
});
```

## Advanced Configuration

Create a broker with additional configuration:

```ts
import AWS from "alchemy/aws/control";

const advancedBroker = await AWS.AmazonMQ.Broker("advanced-broker", {
  HostInstanceType: "example-hostinstancetype",
  Users: [],
  BrokerName: "broker-broker",
  DeploymentMode: "example-deploymentmode",
  EngineType: "example-enginetype",
  PubliclyAccessible: true,
  Tags: {
    Environment: "production",
    Team: "DevOps",
    Project: "MyApp",
    CostCenter: "Engineering",
    ManagedBy: "Alchemy",
  },
  Configuration: "example-configuration",
});
```

