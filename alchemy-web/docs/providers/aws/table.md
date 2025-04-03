# Table

The Table component allows you to create and manage [Amazon DynamoDB](https://aws.amazon.com/dynamodb/) tables with support for partition and sort keys, flexible billing modes, and automatic table status monitoring.

# Minimal Example

```ts
import { Table } from "alchemy/aws";

const table = await Table("user-events", {
  tableName: "user-events",
  partitionKey: {
    name: "id",
    type: "S"
  },
  sortKey: {
    name: "timestamp",
    type: "N"
  },
  tags: {
    Environment: "test"
  }
});
```

# Create the Table

```ts
import { Table } from "alchemy/aws";

// Create a table with provisioned capacity
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