# Table

**Type:** `AWS.DynamoDB.Table`

## Props

| Property | Type | Required | Default | Description |
|----------|------|----------|---------|-------------|
| items | `type<Items>` | Yes | - | - |
| attributes | `Attributes` | Yes | - | - |
| partitionKey | `PartitionKey` | Yes | - | - |
| sortKey | `SortKey` | No | - | - |
| tableName | `string \| undefined` | No | - | - |
| billingMode | `DynamoDB.BillingMode` | No | - | - |
| deletionProtectionEnabled | `boolean` | No | - | - |
| onDemandThroughput | `DynamoDB.OnDemandThroughput` | No | - | - |
| provisionedThroughput | `DynamoDB.ProvisionedThroughput` | No | - | - |
| sseSpecification | `DynamoDB.SSESpecification` | No | - | - |
| timeToLiveSpecification | `DynamoDB.TimeToLiveSpecification` | No | - | - |
| warmThroughput | `DynamoDB.WarmThroughput` | No | - | - |
| tableClass | `DynamoDB.TableClass` | No | - | - |

## Attributes

| Attribute | Type | Description |
|-----------|------|-------------|
| tableName | `Props["tableName"] extends string ? Props["tableName"] : string` | - |
| tableId | `string` | - |
| tableArn | ``arn:aws:dynamodb:${RegionID}:${AccountID}:table/${this["tableName"]}`` | - |
| partitionKey | `Props["partitionKey"]` | - |
| sortKey | `Props["sortKey"]` | - |

## Capabilities

### GetItem

**Type:** `AWS.DynamoDB.GetItem`

#### Functions

- `getItem(...)`
