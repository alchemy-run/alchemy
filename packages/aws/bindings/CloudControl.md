<!-- Docs for the generated AWS.CloudControl bindings: one `## <Binding>` section each, the JSDoc body verbatim. -->

## CancelResourceRequest

Runtime binding for `cloudformation:CancelResourceRequest`.

Cancels a resource operation request that is still `PENDING` or
`IN_PROGRESS` — the companion to {@link CreateResource} /
{@link UpdateResource} / {@link DeleteResource} for aborting slow or
mistaken provisioning operations.
### Tracking Requests
**Example:** Cancel an in-flight operation
```typescript
const cancelResourceRequest = yield* CloudControl.CancelResourceRequest();

// runtime
yield* cancelResourceRequest({
  RequestToken: created.ProgressEvent!.RequestToken!,
});
```

@binding

## GetResourceRequestStatus

Runtime binding for `cloudformation:GetResourceRequestStatus`.

Polls the status of an asynchronous Cloud Control operation started with
{@link CreateResource}, {@link UpdateResource}, or {@link DeleteResource}
until its `OperationStatus` settles (`SUCCESS` / `FAILED` / `CANCEL_COMPLETE`).
### Tracking Requests
**Example:** Poll a request token until it settles
```typescript
const getResourceRequestStatus =
  yield* CloudControl.GetResourceRequestStatus();

// runtime — bounded poll every 2s until the operation settles
const settled = yield* getResourceRequestStatus({
  RequestToken: created.ProgressEvent!.RequestToken!,
}).pipe(
  Effect.repeat({
    schedule: Schedule.spaced("2 seconds"),
    until: (r): boolean =>
      r.ProgressEvent?.OperationStatus !== "PENDING" &&
      r.ProgressEvent?.OperationStatus !== "IN_PROGRESS",
    times: 30,
  }),
);
```

@binding

## ListResourceRequests

Runtime binding for `cloudformation:ListResourceRequests`.

Lists resource operation requests made in the account and Region over the
last 7 days — useful for surfacing in-flight or failed provisioning
operations from a management Function.
### Tracking Requests
**Example:** List in-progress operations
```typescript
const listResourceRequests = yield* CloudControl.ListResourceRequests();

// runtime
const page = yield* listResourceRequests({
  ResourceRequestStatusFilter: { OperationStatuses: ["IN_PROGRESS"] },
  MaxResults: 20,
});
```

@binding
