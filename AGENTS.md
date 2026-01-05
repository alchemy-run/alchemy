# alchemy-effect

**Generated:** 2026-01-05 | **Commit:** 931f322

## OVERVIEW

Infrastructure-as-Effects (IaE) framework unifying business logic + infrastructure config in type-safe Effect-TS programs. AWS + Cloudflare providers.

## STRUCTURE

```
./
├── alchemy-effect/       # Main package (nested same name)
│   ├── src/              # Core + providers
│   ├── test/             # Provider + integration tests
│   └── bin/              # CLI entry (.ts, not .js)
├── examples/             # AWS + Cloudflare examples
│   ├── aws/              # Lambda + SQS + DynamoDB example
│   └── cloudflare/       # Worker + KV + R2 example
└── scripts/              # Release tooling
```

## WHERE TO LOOK

| Task | Location | Notes |
|------|----------|-------|
| Declare Resource | `src/aws/sqs/queue.ts` | Resource factory pattern |
| Implement Provider | `src/aws/sqs/queue.provider.ts` | create/update/delete/diff |
| Implement Binding | `src/aws/sqs/queue.send-message.ts` | Push-based (attach) |
| Event Source Binding | `src/aws/sqs/queue.event-source.ts` | Pull-based (postattach) |
| Fine-grained IAM | `src/aws/dynamodb/table.get-item.ts` | Type-level constraints |
| Runtime (Function) | `src/aws/lambda/function.ts` | Lambda/Worker declaration |
| Provider tests | `test/aws/sqs/queue.provider.test.ts` | Idempotent patterns |
| Smoke tests | `test/aws/ec2/vpc.test.ts` | Multi-stage evolution |
| Usage examples | `examples/aws/src/api.ts` | Real usage patterns |

## CORE CONCEPTS

**Triple**: Resources + Functions + Bindings
- **Resource**: Infrastructure component (Queue, Table, VPC)
- **Function**: Runtime with business logic (Lambda, Worker)
- **Binding**: Connects Function to Resource, generates IAM policies

## PROVIDER IMPLEMENTATION

```typescript
ResourceName.provider.effect(
  Effect.gen(function* () {
    return {
      stables: ["physicalId", "arn"],  // Immutable outputs
      diff: Effect.fn(function* ({ news, olds, output }) {
        // Return { action: "replace" } OR undefined (allow update)
        // NEVER return { action: "noop" }
      }),
      create: Effect.fn(function* ({ id, news, session }) { ... }),
      update: Effect.fn(function* ({ news, output }) { ... }),
      delete: Effect.fn(function* ({ output }) { ... }),
    };
  })
)
```

**Tips:**
- `diff` returns `undefined` for updateable props (not `{ action: "noop" }`)
- Conditionally include service-specific attrs (FIFO attrs only for FIFO queues)

## ANTI-PATTERNS

| NEVER | DO INSTEAD |
|-------|------------|
| `Effect.catchAll` | `Effect.catchTag` / `Effect.catchTags` |
| `any` types | Proper typing or generics |
| Non-null assertion `!` | Proper null handling |
| Type assertions `as T` | Type guards or refinements |
| Delete `.alchemy/` dir | `yield* destroy()` in tests |
| Manual AWS resource deletion | Idempotent test patterns |
| npm/pnpm/yarn | `bun` only |

## CONVENTIONS

- **Error handling**: Always `Effect.catchTag("ErrorName", ...)` for specific errors
- **Physical names**: `yield* createPhysicalName({ id, maxLength: 80 })`
- **Tagging**: All resources tagged `alchemy::app`, `alchemy::stage`, `alchemy::id`
- **Session notes**: `yield* session.note("status")` for progress
- **Retry**: `Effect.retry({ schedule: Schedule.exponential(100) })`

## COMMANDS

```bash
# Development
bun install                    # Install deps
bun run build                  # Build package
bun run format                 # Format with oxfmt

# Testing
bun vitest run ./alchemy-effect/test/<path>.test.ts
DEBUG=1 bun vitest run ...     # With debug logs

# Release
bun run publish:npm            # Publish to npm
```

## TESTING RULES

1. **Always** start tests with `yield* destroy()` to clean state
2. **Never** delete `.alchemy/` - tests are idempotent
3. **Never** manually delete AWS/Cloudflare resources
4. If state seems corrupted → STOP and report

## NOTES

- Currying required for Functions: `Lambda.serve(..)({ .. })` (TS limitation)
- Package nested: `alchemy-effect/alchemy-effect/` contains actual code
- Examples reference `example/` in AGENTS.md but actual dir is `examples/` (plural)
