<!-- Docs for the generated AWS.ResourceExplorer bindings: one `## <Binding>` section each, the JSDoc body verbatim. -->

## ListSupportedResourceTypes

Runtime binding for `resource-explorer-2:ListSupportedResourceTypes`.

Enumerates the resource types Resource Explorer can index and search —
the discovery half of query-building: validate a `service:`/`resourcetype:`
filter before searching, or drive a resource-type picker. Account-level
operation, so the binding takes no resource argument. Provide the
implementation with
`Effect.provide(AWS.ResourceExplorer.ListSupportedResourceTypesHttp)`.
### Listing Resources
**Example:** Enumerate Searchable Resource Types
```typescript
// init — account-level binding, no resource argument
const listSupportedResourceTypes =
  yield* AWS.ResourceExplorer.ListSupportedResourceTypes();

// runtime
const { ResourceTypes } = yield* listSupportedResourceTypes();
const s3Types = (ResourceTypes ?? []).filter((t) => t.Service === "s3");
```

@binding
