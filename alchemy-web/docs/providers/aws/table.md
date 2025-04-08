# DynamoDB Table

The DynamoDB Table resource lets you create and manage [Amazon DynamoDB](https://aws.amazon.com/dynamodb/) tables in your application.

# Minimal Example

Create a basic DynamoDB table with just a partition key:

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

Create a table with both partition and sort keys for time-series data:

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
  }
});
```

# Create a Provisioned Table

Create a table with provisioned throughput capacity:

```ts
import { Table } from "alchemy/aws";

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