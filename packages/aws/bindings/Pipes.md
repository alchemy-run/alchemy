<!-- Docs for the generated AWS.Pipes bindings: one `## <Binding>` section each, the JSDoc body verbatim. -->

## DescribePipe

Runtime binding for `pipes:DescribePipe`.

Reads the bound {@link Pipe}'s full definition and live state
(`CurrentState`, `DesiredState`, source/enrichment/target parameters) —
e.g. an operational dashboard or a controller that checks whether the
pipe settled after a start/stop. The pipe name is injected from the
binding. Provide the implementation with
`Effect.provide(AWS.Pipes.DescribePipeHttp)`.
### Observing a Pipe
**Example:** Read the Pipe's Live State
```typescript
// init — bind the operation to the pipe
const describePipe = yield* AWS.Pipes.DescribePipe(pipe);

// runtime
const described = yield* describePipe();
// described.CurrentState === "RUNNING"
```

@binding

## ListPipes

Runtime binding for `pipes:ListPipes`.

Lists the account's pipes, optionally filtered by name prefix, current
state, or source/target prefix — e.g. an operational console enumerating
the pipes it manages. Account-level: no resource argument. Provide the
implementation with `Effect.provide(AWS.Pipes.ListPipesHttp)`.
### Observing a Pipe
**Example:** List Pipes by Name Prefix
```typescript
// init — account-level binding, no resource argument
const listPipes = yield* AWS.Pipes.ListPipes();

// runtime
const { Pipes } = yield* listPipes({ NamePrefix: "orders-" });
// [{ Name: "orders-pipe", CurrentState: "RUNNING", ... }, ...]
```

@binding

## StartPipe

Runtime binding for `pipes:StartPipe`.

Starts the bound {@link Pipe} after it was stopped — e.g. resuming
source polling on a schedule or in response to an operational signal.
The response reports the transitional `STARTING`/desired `RUNNING`
states; use {@link DescribePipe} to observe when the pipe settles. The
pipe name is injected from the binding. Provide the implementation with
`Effect.provide(AWS.Pipes.StartPipeHttp)`.
### Controlling a Pipe
**Example:** Resume a Stopped Pipe
```typescript
// init — bind the operation to the pipe
const startPipe = yield* AWS.Pipes.StartPipe(pipe);

// runtime
const response = yield* startPipe();
// response.DesiredState === "RUNNING"
```

@binding

## StopPipe

Runtime binding for `pipes:StopPipe`.

Stops the bound {@link Pipe} without deleting it — e.g. pausing source
polling during a maintenance window or in response to a poison-pill
backlog. The response reports the transitional `STOPPING`/desired
`STOPPED` states; use {@link DescribePipe} to observe when the pipe
settles. The pipe name is injected from the binding. Provide the
implementation with `Effect.provide(AWS.Pipes.StopPipeHttp)`.
### Controlling a Pipe
**Example:** Pause a Running Pipe
```typescript
// init — bind the operation to the pipe
const stopPipe = yield* AWS.Pipes.StopPipe(pipe);

// runtime
const response = yield* stopPipe();
// response.DesiredState === "STOPPED"
```

@binding
