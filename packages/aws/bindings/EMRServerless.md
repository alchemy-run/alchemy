<!-- Docs for the generated AWS.EMRServerless bindings: one `## <Binding>` section each, the JSDoc body verbatim. -->

## StartApplication

Runtime binding for `emr-serverless:StartApplication`.

Starts the bound {@link Application} — pre-warming its pre-initialized
capacity ahead of a burst of job submissions so the first job skips the
application cold start. Provide the implementation with
`Effect.provide(AWS.EMRServerless.StartApplicationHttp)`.
### Application Control
**Example:** Warm Up Before A Batch Window
```typescript
// init
const startApplication = yield* AWS.EMRServerless.StartApplication(app);

// runtime
yield* startApplication();
```

@binding

## StopApplication

Runtime binding for `emr-serverless:StopApplication`.

Stops the bound {@link Application}, releasing its pre-initialized
capacity so it stops billing — e.g. a scheduled cost-control function that
shuts the application down outside business hours. Provide the
implementation with `Effect.provide(AWS.EMRServerless.StopApplicationHttp)`.
### Application Control
**Example:** Stop Outside Business Hours
```typescript
// init
const stopApplication = yield* AWS.EMRServerless.StopApplication(app);

// runtime
yield* stopApplication();
```

@binding
