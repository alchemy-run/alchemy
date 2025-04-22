# Table

The Table resource lets you create and manage [Amazon DynamoDB tables](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/Introduction.html) for your application.

## Minimal Example

Create a basic table with just a partition key:

```ts
import { Table } from "alchemy/aws";

const table = await Table("users", {
  tableName: "users",
  partitionKey: {
    name: "userId", 
    type: "S"
  }
});
```

## Table with Sort Key

Add a sort key to enable range queries and multiple items per partition:

```ts
const table = await Table("events", {
  tableName: "events",
  partitionKey: {
    name: "deviceId",
    type: "S"
  },
  sortKey: {
    name: "timestamp",
    type: "N"
  }
});
```

## Provisioned Capacity

Configure provisioned read/write capacity for predictable workloads:

```ts
const table = await Table("orders", {
  tableName: "orders", 
  partitionKey: {
    name: "orderId",
    type: "S"
  },
  billingMode: "PROVISIONED",
  readCapacity: 100,
  writeCapacity: 50,
  tags: {
    Environment: "production"
  }
});
```