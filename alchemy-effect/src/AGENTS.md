# src

Core library: declarative infra abstractions + Effect-based planning/execution engine.

## STRUCTURE

```
./
├── plan.ts              # Plan graph builder (1129 lines)
├── apply.ts             # Execution engine (867 lines)
├── output.ts            # Output/reference resolution (544 lines)
├── state.ts             # State management (.alchemy/) (390 lines)
├── resource.ts          # Resource base abstraction
├── provider.ts          # Provider service interface
├── binding.ts           # Capability binding (240 lines)
├── capability.ts        # Fine-grained permissions
├── runtime.ts           # Function/handler abstraction (152 lines)
├── policy.ts            # IAM policy builder (128 lines)
├── aws/                 # AWS provider
│   ├── lambda/          # function.ts, function.provider.ts, function.invoke.ts, serve.ts
│   ├── sqs/             # queue.ts, queue.provider.ts, queue.send-message.ts, queue.event-source.ts
│   ├── dynamodb/        # table.ts, table.provider.ts, table.get-item.ts, expr.ts, projection.ts
│   └── ec2/             # vpc.ts, subnet.ts, security-group.ts, route-table.ts, etc.
├── cloudflare/          # Cloudflare provider
│   ├── worker/          # worker.ts, worker.provider.ts
│   ├── kv/              # namespace.ts, namespace.provider.ts
│   └── r2/              # bucket.ts, bucket.provider.ts
└── cli/                 # CLI runtime (ink-service.tsx, service.ts)
```

## WHERE TO LOOK

| Task | File | Notes |
|------|------|-------|
| Plan DAG construction | plan.ts:1-1129 | Node creation, diffing, topological sort |
| Apply execution | apply.ts:1-867 | CRUD orchestration, state management |
| Output resolution | output.ts:1-544 | Reference flattening, dependency tracking |
| State persistence | state.ts:1-390 | .alchemy/ file ops, version handling |
| Resource declaration | resource.ts:1-140 | Resource factory pattern |
| Provider contract | provider.ts:1-113 | create/update/delete/diff interface |
| Binding mechanics | binding.ts:1-240 | Capability attachment to Runtime |
| IAM policy generation | policy.ts:1-128 | Type-safe policy builder |
| Runtime abstraction | runtime.ts:1-152 | Lambda/Worker base |

## CONVENTIONS

**Naming:**
- `{resource}.ts` - Resource declaration (e.g. `queue.ts`, `table.ts`)
- `{resource}.provider.ts` - Provider implementation (CRUD)
- `{resource}.{operation}.ts` - Bindings (e.g. `queue.send-message.ts`, `table.get-item.ts`)
- `{resource}.event-source.ts` - Pull-based bindings (attach + postattach)

**Patterns:**
- Resources: Factory returning typed Resource object with `id`, `type`, `props`
- Providers: Effect returning `{ stables, diff, create, update, delete }`
- Bindings: Effect returning `{ policy, attach?, postattach? }`
- State: Immutable updates via `State.update`, never mutate directly

## COMPLEXITY HOTSPOTS

**plan.ts (1129 lines)**
- DAG building: Node creation, dependency tracking, topological sort
- Diffing: Property changes → action (create/update/replace/delete/noop)
- Binding resolution: Attach/detach/postattach sequencing
- Hot paths: `buildPlanGraph` (100+ lines), `buildBindingNodes` (200+ lines)

**apply.ts (867 lines)**
- Execution: Sequential CRUD with state checkpointing
- Error recovery: Rollback on failure, partial state preservation
- Binding application: Two-phase (attach → postattach)
- Hot paths: `executeNode` (150+ lines), `applyBindings` (100+ lines)

**output.ts (544 lines)**
- Reference flattening: Resolves `Output<T>` to `T` via dependency graph
- Circular detection: Prevents infinite loops
- Hot paths: `flattenOutputs` (200+ lines)

**binding.ts (240 lines)**
- Type gymnastics: Infers Capability constraints, Runtime binding shape
- Context passing: Effect Context for service injection
- Policy merging: Combines multiple capability policies
