<!-- Docs for the generated AWS.CloudMap bindings: one `## <Binding>` section each, the JSDoc body verbatim. -->

## GetOperation

Runtime binding for `servicediscovery:GetOperation` — reads the status of
an asynchronous Cloud Map operation. `RegisterInstance` and
`DeregisterInstance` return an `OperationId`; poll it with this binding
to await completion (`SUCCESS` / `FAIL`) before relying on the
registration. Provide the implementation with
`Effect.provide(AWS.CloudMap.GetOperationHttp)`.
### Registering Instances
**Example:** Await a Registration Operation
```typescript
const registerInstance = yield* AWS.CloudMap.RegisterInstance(service);
const getOperation = yield* AWS.CloudMap.GetOperation();

const { OperationId } = yield* registerInstance({
  InstanceId: "worker-1",
  Attributes: { AWS_INSTANCE_IPV4: "10.0.1.10" },
});
const { Operation } = yield* getOperation({ OperationId: OperationId! });
console.log(Operation?.Status); // "SUBMITTED" | "PENDING" | "SUCCESS" | "FAIL"
```

@binding
