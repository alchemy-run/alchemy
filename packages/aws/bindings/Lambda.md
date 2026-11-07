<!-- Docs for the generated AWS.Lambda bindings: one `## <Binding>` section each, the JSDoc body verbatim. -->

## GetAccountSettings

Runtime binding for `lambda:GetAccountSettings`.

An account-level binding — call it with no arguments to get a callable
that reads the region's Lambda quotas (`AccountLimit`) and current usage
(`AccountUsage`). Provide the `GetAccountSettingsHttp` layer on the
Function to satisfy the binding.
### Account Settings
**Example:** Read account limits and usage
```typescript
const getAccountSettings = yield* AWS.Lambda.GetAccountSettings();

const settings = yield* getAccountSettings();
const concurrency = settings.AccountLimit?.ConcurrentExecutions;
```

@binding

## GetFunction

Runtime binding for `lambda:GetFunction`.

Reads the bound {@link Function}'s configuration, code location, and tags —
useful for introspection and operational tooling at runtime. Provide the
`GetFunctionHttp` layer on the Function to satisfy the binding.
### Function Metadata
**Example:** Read a function's configuration
```typescript
const getFunction = yield* AWS.Lambda.GetFunction(target);

const response = yield* getFunction();
const memory = response.Configuration?.MemorySize;
```

@binding

## InvokeFunction

@binding

## InvokeWithResponseStream

Runtime binding for `lambda:InvokeFunction` over the response-streaming
API. Invokes the bound {@link Function} and returns the streaming
response — `EventStream` yields `PayloadChunk` events followed by a final
`InvokeComplete` event.

Provide the `InvokeWithResponseStreamHttp` layer on the Function to
satisfy the binding.
### Invoking Functions
**Example:** Stream a function's response
```typescript
const invokeStream = yield* AWS.Lambda.InvokeWithResponseStream(target);

const response = yield* invokeStream({
  Payload: new TextEncoder().encode(JSON.stringify({ prompt: "hi" })),
});
const chunks = yield* Stream.runCollect(response.EventStream!);
```

@binding

## ListFunctions

Runtime binding for `lambda:ListFunctions`.

An account-level binding — call it with no arguments to get a callable
that lists function configurations in the region. Provide the
`ListFunctionsHttp` layer on the Function to satisfy the binding.
### Function Metadata
**Example:** List functions in the region
```typescript
const listFunctions = yield* AWS.Lambda.ListFunctions();

const response = yield* listFunctions({ MaxItems: 50 });
const names = response.Functions?.map((f) => f.FunctionName);
```

@binding
