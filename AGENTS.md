# alchemy-effect

Conduct each engagement with the user as follows:

1. Read the [README](README.md) to get a high-level overview of the project.
2. Read the following code files to familiarize yourself with the common tasks:
  - Declaring a Resource (see [queue.ts](alchemy-effect/src/aws/sqs/queue.ts))
  - Implementing a Resource Provider (see [queue.provider.ts](alchemy-effect/src/aws/sqs/queue.provider.ts) or [table.provider.ts](alchemy-effect/src/aws/dynamodb/table.provider.ts))
  - Declaring a Capability (see [queue.consume.ts](alchemy-effect/src/aws/sqs/queue.consume.ts))
  - Implementing a Capability's Binding:
    - Push-based Binding (see [queue.send-message.ts](alchemy-effect/src/aws/sqs/queue.send-message.ts))
    - Pull-based Binding using postattach (see [queue.event-source.ts](alchemy-effect/src/aws/sqs/queue.event-source.ts))
    - Fine-grained IAM policy modelling in the type-system (see [table.get-item.ts](alchemy-effect/src/aws/dynamodb/table.get-item.ts))
  - Declaring a Function (aka Runtime) see [function.ts](alchemy-effect/src/aws/lambda/function.ts)
  - Creating a Client for an AWS scope (see [aws/lambda/client.ts](alchemy-effect/src/aws/lambda/client.ts) and [aws/sqs/client.ts](alchemy-effect/src/aws/sqs/client.ts))
  - Compiling the AWS.live layer (see [aws/index.ts](alchemy-effect/src/aws/index.ts))
  - Using resources (see [example/src/api.ts](example/src/api.ts) and [example/src/consumer.ts](example/src/consumer.ts))
3. When implementing a Resource Provider, make sure to read the [itty-aws](./alchemy-effect/node_modules/itty-aws/dist/services/*/types.d.ts)  type defnitions for that service and come up with a plan for which errors to retry, which to consider fatal, and design the overall create, update, delete flow for each of the resource lifecycle handlers. We are using effect, so we gain the benefit of type-safe errors, delcarative retry behavior (declarative flow control).