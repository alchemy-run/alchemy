> ⚠️ `alchemy-effect` is still experimental and not ready for production use (expect breaking changes). Come hang in our [Discord](https://discord.gg/jwKw8dBJdN) to participate in the early stages of development.

# `alchemy-effect`

`alchemy-effect` is an **Infrastructure-as-Effects (IaE)** framework that unifies business logic and infrastructure config into a single, type-safe program with the following benefits:
1. Type-Checked IAM Policies
2. Optimally Tree-Shaken Bundles
3. Testable Business Logic
4. Re-usable Components
5. Reviewable Deployment Plans 

## Least-Privilege IAM Policies 🔐

Type-checked Bindings ensure your IAM Policies are least-privilege - you are never missing or granting excessive permissions:

<img src="./images/alchemy-effect.gif" alt="alchemy-effect type checked policies" width="600"/>

You will receive a type error if you mess up your Bindings:
<img src="./images/alchemy-effect-policy-error.png" alt="alchemy-effect type errors" width="600"/>

> [!TIP]
> This error means you are missing the `SendMessage<Messages>` binding (you provided `never` instead of `SendMessage<Messages>`).

## Plan & Deploy
An `alchemy-effect` program produces a Plan that can be reviewed prior to deployment:

<img src="./images/alchemy-effect-plan.gif" alt="alchemy-effect plan video" width="600"/>

## Type-Level Plan 
All knowable information about the Plan is available at compile-time:

<img src="./images/alchemy-effect-plan-type.png" alt="alchemy-effect plan type" width="600"/>

> [!TIP]
> These types can be used to implement type-level validation of infrastructure policies, e.g. disallowing publicly accessible S3 buckets.

## Optimal Tree-Shaking

Provide runtime clients as Layers and `export` a handler that can be optimally tree-shaken to only include necessary code.

```ts
export default Api.handler.pipe(
  Effect.provide(SQS.clientFromEnv()),
  Lambda.toHandler,
);
```

## Pluggable Layers 
Everything (including the CLI) is provided as Effect layers:

<img src="./images/alchemy-effect-layers.png" alt="alchemy-effect layers" width="600"/>

## Literally Typed Outputs
The output of deploying a stack is totally known at compile-time, e.g. the `.fifo` suffix of a SQS FIFO Queue:

<img src="./images/alchemy-effect-output.png" alt="alchemy-effect output" width="600"/>

# Concepts 🔱 

<img src="./images/alchemy-effect-triple.png" alt="alchemy-effect logo" width="600"/>

Infrastructure-as-Effects has three main concepts: `Resources`, `Functions (as Effects)`, and `Bindings`:

- `Resources` are the underlying infrastructure components, e.g. a SQS Queue or DynamoDB Table.
- `Functions` contain the business logic as an Effect running in some runtime, e.g. a Lambda Function or a Cloudflare Worker.
- `Bindings` connect `Functions` to `Resources`, e.g. `SQS.SendMessage(Messages)`

## Resources

Resources are declared along-side your business logic as classes, e.g. a FIFO SQS Queue:

```ts
class Messages extends SQS.Queue("Messages", {
  fifo: true,
  schema: S.String,
}) {} 
```

## Functions

Functions are a special kind of Resource that includes a runtime implementation function.

The function always returns an `Effect<A, Err, Req>` which is then used to infer Capabilities and type-check your Bindings.

```ts
class Api extends Lambda.serve("Api", {
  fetch: Effect.fn(function* (event) {
    yield* SQS.sendMessage(Messages, event.body!).pipe(
      Effect.catchAll(() => Effect.void),
    );
  }),
})({
  main: import.meta.filename,
  bindings: $(SQS.SendMessage(Messages)),
}) {}
```

## Bindings

A Binding is a connection between a **Resource** and a **Function** that satisfies a **Capability** (aka. runtime dependency, e.g. `SQS.SendMessage(to: Messages)`).

> [!TIP]
> Bindings are inferred from your business logic and then type-checked to ensure least-privilege IAM policies.

```ts
class Api extends Lambda.serve("Api", {
  // ...
})({
  main: import.meta.filename,
  // Policy<Lambda.Function, SQS.SendMessage<Messages>>
  bindings: $(SQS.SendMessage(Messages)),
}) {}
```

> [!CAUTION]
> Curring (`Lambda.serve(..)({ .. })`) is required because there's a limitation in TypeScript. We hope to simplify this in the future.

# Components

Infrastructure and business logic can be encapsulated as a Component using a simple function. 

```ts
const Monitor = <const ID extends string, ReqAlarm, ReqResolved>(
  id: ID,
  {
    onAlarm,
    onResolved,
  }: {
    onAlarm: (
      batch: SQS.QueueEvent<Message>,
    ) => Effect.Effect<void, never, ReqAlarm>;
    onResolved?: (
      batch: SQS.QueueEvent<Message>,
    ) => Effect.Effect<void, never, ReqResolved>;
  },
) => {
  class Messages extends SQS.Queue(`${id}-Messages`, {
    fifo: true,
    schema: Message,
  }) {}

  return <const Props extends Lambda.FunctionProps<ReqAlarm | ReqResolved>>({
    bindings,
    ...props
  }: Props) =>
    Lambda.consume(id, {
      queue: Messages,
      handle: Effect.fn(function* (batch) {
        yield* SQS.sendMessage(Messages, {
          id: 1,
          value: "1",
        }).pipe(Effect.catchAll(() => Effect.void));
        if (onAlarm) {
          yield* onAlarm(batch);
        }
        if (onResolved) {
          yield* onResolved(batch);
        }
      }),
    })({
      ...props,
      // Components are not leaky - the inner SQS.SendMessage(Messages) binding is not required to be passed in by the caler
      bindings: bindings.and(SQS.SendMessage(Messages)),
    });
};
```

> [!TIP]
> Components are very similar to React components, but for infrastructure. Instead of declaring state in your closure and returning a React element, you declare Resources and return a `Function`.

# Building your own Resources, Capabilities, and Bindings

> [!CAUTION]
> WIP - docs coming soon!