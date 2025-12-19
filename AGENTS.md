# alchemy-effect

Conduct each engagement with the user as follows:

1. Read the [README](README.md) to get a high-level overview of the project.
2. Read the following code files to familiarize yourself with the common tasks:

- Declaring a Resource (see [queue.ts](alchemy-effect/src/aws/sqs/queue.ts))
- Implementing a Resource Provider (see [queue.provider.ts](alchemy-effect/src/aws/sqs/queue.provider.ts) and [table.provider.ts](alchemy-effect/src/aws/dynamodb/table.provider.ts) and [vpc.provider.ts](alchemy-effect/src/aws/ec2/vpc.provider.ts) and [subnet.provider.ts](alchemy-effect/src/aws/ec2/subnet.provider.ts))
- Implementing tests for Resource Providers (see [queue.provider.test.ts](alchemy-effect/test/aws/sqs/queue.provider.test.ts) and [table.provider.test.ts](alchemy-effect/test/aws/dynamodb/table.provider.test.ts) and [vpc.provider.test.ts](alchemy-effect/test/aws/ec2/vpc.provider.test.ts))
- Implementing a comprehensive smoke test, see [vpc.test.ts](alchemy-effect/test/aws/ec2/vpc.test.ts)
- Declaring a Capability (see [queue.consume.ts](alchemy-effect/src/aws/sqs/queue.consume.ts))
- Implementing a Capability's Binding:
  - Push-based Binding (see [queue.send-message.ts](alchemy-effect/src/aws/sqs/queue.send-message.ts))
  - Pull-based Binding using postattach (see [queue.event-source.ts](alchemy-effect/src/aws/sqs/queue.event-source.ts))
  - Fine-grained IAM policy modelling in the type-system (see [table.get-item.ts](alchemy-effect/src/aws/dynamodb/table.get-item.ts))
- Declaring a Function (aka Runtime) see [function.ts](alchemy-effect/src/aws/lambda/function.ts)
- Creating a Client for an AWS scope (see [aws/lambda/client.ts](alchemy-effect/src/aws/lambda/client.ts) and [aws/sqs/client.ts](alchemy-effect/src/aws/sqs/client.ts))
- Compiling the AWS.live layer (see [aws/index.ts](alchemy-effect/src/aws/index.ts))
- Using resources (see [example/src/api.ts](example/src/api.ts) and [example/src/consumer.ts](example/src/consumer.ts))

Provider Implementation Tips:

- The `diff` function should return `undefined` (not `{ action: "noop" }`) when properties don't require replacement - this allows the `update` function to be called for in-place attribute changes.
- Only include service-specific attributes conditionally (e.g., SQS FIFO attributes like `FifoQueue`, `ContentBasedDeduplication` should only be sent for FIFO queues, not standard queues).

Restrictions:

1. Never use `Effect.catchAll`, always use `Effect.catchTag` or `Effect.catchTags`
1. Always use `bun` (never npm, pnpm, yarn, etc.)

:::caution
Never (ever!) delete .alchemy/

Tests are designed ot be idempotent.
When making changes to providers, you should keep running the tests and fixing providers until the tests pass.
If you think the state is corrupted, stop and let me know.
You should always add a `yield* destroy()` at the beginning of each test to clean up state. Do not delete `.alchemy` files or folders.

Never manually delete resources with the aws cli or api calls. Tests must be designed to be idempotent and self-healing.
:::

# Testing

To test, use the following command:

```
bun vitest run ./alchemy-effect/test/<path>/<to>/<test>.test.ts
```

Run with DEBUG=1 to see debug logs, e.g.

```ts
Effect.tapError(Effect.logDebug),
```
