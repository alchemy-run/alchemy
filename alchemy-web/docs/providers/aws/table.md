# DynamoDB Table

The DynamoDB Table resource lets you create and manage [Amazon DynamoDB tables](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/Introduction.html) for NoSQL database storage.

# Minimal Example

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

# Create a Table with Sort Key

```ts
import { Table } from "alchemy/aws";

const table = await Table("events", {
  tableName: "events",
  partitionKey: {
    name: "deviceId",
    type: "S"
  },
  sortKey: {
    name: "timestamp",
    type: "N"
  },
  tags: {
    Environment: "production"
  }
});
```

# Create a Table with Provisioned Capacity

```ts
import { Table } from "alchemy/aws";

const table = await Table("high-throughput", {
  tableName: "high-throughput",
  partitionKey: {
    name: "userId",
    type: "S"
  },
  billingMode: "PROVISIONED",
  readCapacity: 100,
  writeCapacity: 50
});
```