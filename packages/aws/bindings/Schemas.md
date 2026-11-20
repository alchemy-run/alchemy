<!-- Docs for the generated AWS.Schemas bindings: one `## <Binding>` section each, the JSDoc body verbatim. -->

## StartDiscoverer

Runtime binding for `schemas:StartDiscoverer`.

Resumes schema discovery on the bound {@link Discoverer} — e.g. an ops
function re-enabling discovery after a paused window. The discoverer id is
injected from the binding. Provide the implementation with
`Effect.provide(AWS.Schemas.StartDiscovererHttp)`.
### Controlling a Discoverer
**Example:** Resume Discovery
```typescript
// init — bind the operation to the discoverer
const startDiscoverer = yield* AWS.Schemas.StartDiscoverer(discoverer);

// runtime
const { State } = yield* startDiscoverer();
// State === "STARTED"
```

@binding

## StopDiscoverer

Runtime binding for `schemas:StopDiscoverer`.

Pauses schema discovery on the bound {@link Discoverer} — e.g. an ops
function halting discovery during a noisy backfill so junk schemas are not
published to the `discovered-schemas` registry. The discoverer id is
injected from the binding. Provide the implementation with
`Effect.provide(AWS.Schemas.StopDiscovererHttp)`.
### Controlling a Discoverer
**Example:** Pause Discovery
```typescript
// init — bind the operation to the discoverer
const stopDiscoverer = yield* AWS.Schemas.StopDiscoverer(discoverer);

// runtime
const { State } = yield* stopDiscoverer();
// State === "STOPPED"
```

@binding
