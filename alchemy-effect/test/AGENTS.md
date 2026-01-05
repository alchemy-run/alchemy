# test

Test suite: provider tests (AWS/Cloudflare) + core logic (apply/plan/evaluate).

## STRUCTURE

```
test/
├── aws/                      # AWS provider tests
│   ├── sqs/queue.provider.test.ts
│   ├── dynamodb/table.provider.test.ts
│   ├── ec2/vpc.test.ts       # Multi-stage evolution smoke test
│   └── lambda/function.provider.test.ts
├── cloudflare/               # Cloudflare provider tests
│   ├── worker/worker.provider.test.ts
│   ├── kv/namespace.provider.test.ts
│   └── r2/bucket.provider.test.ts
├── apply.test.ts             # Apply logic + failure injection
├── plan.test.ts              # Plan generation + diffs
├── evaluate.test.ts          # Output resolution
├── test.resources.ts         # Mock resources (TestResource, Queue, etc.)
└── handler.ts                # Empty placeholder
```

## TEST PATTERNS

**Custom `test()` wrapper** (`src/test.ts`):
- Wraps `@effect/vitest` with Effect runtime + scoped layers
- Auto-provides: App, State, DotAlchemy, HttpClient, FileSystem
- Options: `{ timeout?, state? }` for custom state layers

**State helpers**:
- `test.state(resources)` - Layer with resources for current app/stage
- `test.defaultState(resources, other?)` - Layer with fixed "test-app"/"test-stage" + additional stacks

**Idempotency**:
- **Always** start tests with `yield* destroy()` to clean state
- **Never** delete `.alchemy/` or manually delete cloud resources
- Run same test multiple times - must produce identical state

**Describe blocks**:
- `"from created state"` - Tests starting from existing resources
- `"from updating state"` - Tests mid-update recovery

## FAILURE INJECTION

**Hooks** (`apply.test.ts`):
- `failOn(resourceId, hook)` - Fail single resource on create/update/delete
- `failOnMultiple([{ id, hook }, ...])` - Fail multiple resources
- `hook(test, { create?, update?, delete?, read? })` - Wrap test with custom TestResourceHooks

**Pattern**:
```typescript
yield* hook(apply(B), failOn("A", "create"));
// Verifies partial state after A fails
```

## EVENTUAL CONSISTENCY

AWS/Cloudflare resources may lag. Use retry:

```typescript
yield* sqs.getQueueAttributes({ QueueUrl })
  .pipe(
    Effect.flatMap(() => Effect.fail(new QueueStillExists())),
    Effect.retry({
      while: (e) => e._tag === "QueueStillExists",
      schedule: Schedule.exponential(100),
    }),
    Effect.catchTag("QueueDoesNotExist", () => Effect.void),
  );
```

## CUSTOM MATCHERS

```typescript
expect.emptyObject()              // Object.keys(x).length === 0
expect.propExpr(id, resource)     // PropExpr validation
```
