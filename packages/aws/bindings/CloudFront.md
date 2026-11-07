<!-- Docs for the generated AWS.CloudFront bindings: one `## <Binding>` section each, the JSDoc body verbatim. -->

## CreateInvalidation

Grants a Function permission to create CloudFront cache invalidations for a
distribution at runtime — the classic post-publish/CMS purge pattern.
### Invalidating from a Function
**Example:** Purge Paths After a Content Update
```typescript
const invalidate = yield* CloudFront.CreateInvalidation(distribution);

const response = yield* invalidate({
  InvalidationBatch: {
    CallerReference: crypto.randomUUID(),
    Paths: { Quantity: 1, Items: ["/blog/*"] },
  },
});
// response.Invalidation?.Id
```

@binding

## DeleteKey

Runtime binding for `cloudfront-keyvaluestore:DeleteKey`.

Deletes a single key from the bound KeyValueStore's data plane. Writes use
optimistic concurrency: pass the store's current `ETag` as `IfMatch` (from
{@link DescribeKeyValueStore} or a previous write's response). Provide the
implementation with `Effect.provide(AWS.CloudFront.DeleteKeyHttp)`.
### Writing KeyValueStore Data
**Example:** Delete a Key
```typescript
// init — bind the operations to the store
const describeStore = yield* CloudFront.DescribeKeyValueStore(store);
const deleteKey = yield* CloudFront.DeleteKey(store);

// runtime
const meta = yield* describeStore({});
yield* deleteKey({ Key: "routes:/about", IfMatch: meta.ETag });
```

@binding

## DescribeKeyValueStore

Runtime binding for `cloudfront-keyvaluestore:DescribeKeyValueStore`.

Reads the bound KeyValueStore's data-plane metadata — item count, total
size, and the current `ETag` that write operations ({@link PutKey},
{@link DeleteKey}, {@link UpdateKeys}) require as `IfMatch`. Provide the
implementation with `Effect.provide(AWS.CloudFront.DescribeKeyValueStoreHttp)`.
### Reading KeyValueStore Data
**Example:** Fetch the Store's ETag Before a Write
```typescript
// init — bind the operation to the store
const describeStore = yield* CloudFront.DescribeKeyValueStore(store);

// runtime
const meta = yield* describeStore({});
console.log(meta.ETag, meta.ItemCount);
```

@binding

## GetInvalidation

Runtime binding for `cloudfront:GetInvalidation`.

Reads the status of a cache invalidation on the bound distribution —
pairs with {@link CreateInvalidation} to poll a purge to `Completed`.
Provide the implementation with
`Effect.provide(AWS.CloudFront.GetInvalidationHttp)`.
### Inspecting Invalidations
**Example:** Poll an Invalidation's Status
```typescript
// init — bind the operation to the distribution
const getInvalidation = yield* CloudFront.GetInvalidation(distribution);

// runtime
const res = yield* getInvalidation({ Id: invalidationId });
console.log(res.Invalidation?.Status); // "InProgress" | "Completed"
```

@binding

## GetKey

Runtime binding for `cloudfront-keyvaluestore:GetKey`.

Reads a single key's value from the bound KeyValueStore's data plane.
Values are sensitive — distilled decodes them as `Redacted<string>`;
unwrap with `Redacted.value`. Provide the implementation with
`Effect.provide(AWS.CloudFront.GetKeyHttp)`.
### Reading KeyValueStore Data
**Example:** Read a Key
```typescript
// init — bind the operation to the store
const getKey = yield* CloudFront.GetKey(store);

// runtime
const res = yield* getKey({ Key: "routes:/about" });
const value = typeof res.Value === "string" ? res.Value : Redacted.value(res.Value);
```

@binding

## ListInvalidations

Runtime binding for `cloudfront:ListInvalidations`.

Lists the cache invalidations of the bound distribution (paginated via
`Marker`/`MaxItems`). Provide the implementation with
`Effect.provide(AWS.CloudFront.ListInvalidationsHttp)`.
### Inspecting Invalidations
**Example:** List Recent Invalidations
```typescript
// init — bind the operation to the distribution
const listInvalidations = yield* CloudFront.ListInvalidations(distribution);

// runtime
const res = yield* listInvalidations({ MaxItems: 10 });
console.log(res.InvalidationList?.Items?.map((i) => i.Id));
```

@binding

## ListKeys

Runtime binding for `cloudfront-keyvaluestore:ListKeys`.

Lists key/value pairs in the bound KeyValueStore's data plane (paginated
via `NextToken`/`MaxResults`). Provide the implementation with
`Effect.provide(AWS.CloudFront.ListKeysHttp)`.
### Reading KeyValueStore Data
**Example:** List Keys
```typescript
// init — bind the operation to the store
const listKeys = yield* CloudFront.ListKeys(store);

// runtime
const res = yield* listKeys({ MaxResults: 50 });
console.log(res.Items?.map((item) => item.Key));
```

@binding

## PutKey

Runtime binding for `cloudfront-keyvaluestore:PutKey`.

Creates or replaces a single key in the bound KeyValueStore's data plane.
Writes use optimistic concurrency: pass the store's current `ETag` as
`IfMatch` (from {@link DescribeKeyValueStore} or a previous write's
response). Provide the implementation with
`Effect.provide(AWS.CloudFront.PutKeyHttp)`.
### Writing KeyValueStore Data
**Example:** Put a Key
```typescript
// init — bind the operations to the store
const describeStore = yield* CloudFront.DescribeKeyValueStore(store);
const putKey = yield* CloudFront.PutKey(store);

// runtime
const meta = yield* describeStore({});
const res = yield* putKey({
  Key: "routes:/about",
  Value: "/about.html",
  IfMatch: meta.ETag,
});
// res.ETag is the store's new entity tag
```

@binding

## UpdateKeys

Runtime binding for `cloudfront-keyvaluestore:UpdateKeys`.

Puts and/or deletes multiple keys in the bound KeyValueStore's data plane
as a single all-or-nothing batch. Writes use optimistic concurrency: pass
the store's current `ETag` as `IfMatch` (from
{@link DescribeKeyValueStore} or a previous write's response). Provide the
implementation with `Effect.provide(AWS.CloudFront.UpdateKeysHttp)`.
### Writing KeyValueStore Data
**Example:** Batch Put + Delete
```typescript
// init — bind the operations to the store
const describeStore = yield* CloudFront.DescribeKeyValueStore(store);
const updateKeys = yield* CloudFront.UpdateKeys(store);

// runtime
const meta = yield* describeStore({});
yield* updateKeys({
  IfMatch: meta.ETag,
  Puts: [{ Key: "routes:/", Value: "/index.html" }],
  Deletes: [{ Key: "routes:/legacy" }],
});
```

@binding
