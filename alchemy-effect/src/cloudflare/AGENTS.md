# cloudflare

Cloudflare provider: Worker runtime + KV/R2 resources with Effect-wrapped SDK.

## STRUCTURE

```
./
├── worker/               # Worker runtime + bundling
│   ├── worker.ts         # Runtime (not Resource)
│   ├── worker.provider.ts # Bundling + asset upload
│   └── assets.provider.ts # Hash-based change detection
├── kv/                   # KV namespace resource
│   ├── namespace.ts      # Resource declaration
│   ├── namespace.binding.ts # Binding config
│   └── namespace.client.ts # Runtime operations
├── r2/                   # R2 bucket resource
│   ├── bucket.ts         # Resource declaration
│   ├── bucket.binding.ts # Binding config
│   ├── bucket.client.ts  # Runtime operations
│   └── bucket.*.ts       # CRUD operations
├── api.ts                # CloudflareApi: SDK wrapped in Effect
├── context.ts            # CloudflareContext: env + ctx
├── stream.ts             # Effect.Stream ↔ ReadableStream
└── account.ts            # Account ID config
```

## SERVICE PATTERNS

**Resource** (KV, R2): Standard Resource pattern with `.provider` + `.binding`
**Worker**: Extends `Runtime` not `Resource` - no `.provider`, bundling in `worker.provider.ts`

**Bindings return config from `attach()`**:
```typescript
Bind.provider.succeed({
  attach: ({ source }) => ({
    bindings: [{ type: "kv_namespace", name: source.id, ... }]
  })
})
```
Worker collects all `bindings` arrays and passes to Cloudflare API.

## WORKER SPECIFICS

**Bundle + Assets**:
- ESBuild bundles `main` → single `.js` file
- Hash bundle + assets to detect changes (`sha256`)
- Assets: directory scan → manifest → upload only changed hashes
- `diff()` compares hashes, returns `{ action: "update" }` if changed

**Assets validation**:
- Max 25MB per file, 20k files total
- `.assetsignore` + `_headers`/`_redirects` support
- Upload batched by Cloudflare-returned buckets

**CloudflareApi**:
- Recursive proxy wraps SDK methods → `Effect<T, CloudflareApiError>`
- Tagged errors: `NotFound`, `Authentication`, `Conflict`, etc.
- Use `Effect.catchTag("NotFound", ...)` not `catchAll`

**Runtime context**:
- `CloudflareContext` provides `{ env, ctx }` at runtime
- `getCloudflareEnvKey<T>(key)` retrieves binding from env
- Bindings injected via `env[source.id]` (ID as binding name)
