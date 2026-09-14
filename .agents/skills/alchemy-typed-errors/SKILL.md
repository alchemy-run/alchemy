---
name: alchemy-typed-errors
description: Patch distilled SDK errors with typed model updates.
---

# Alchemy Typed Errors

## When to use

Load when a generated SDK has a missing or incorrect error type, schema, operation, or response shape.

# Typed Error Doctrine (distilled)

## How distilled is built (Smithy + JSON Patch)

Distilled is a Smithy-based SDK factory. Every provider package (`submodules/distilled/packages/{cloud}`) runs the same pipeline:

1. **Convert** — the provider's spec source is converted into Smithy 2.0 JSON models, one per service, in `.generated-specs/{service}.json`. Cloudflare mines them from the downloaded API docs (`scripts/spec-to-smithy.ts` over `specs/api/resources/**`); AWS consumes the official `api-models-aws` Smithy models submodule directly. Hand-authored models for APIs the spec source doesn't cover live in `manual-specs/`.
2. **Patch** — an **RFC 6902 JSON Patch chain** (files shaped `{ "description": ..., "patches": [ops] }`) is applied to the provider's intermediary spec before codegen. For Cloudflare, patches in `patches/{service}/*.json` target the **Smithy model**, applied in filename order with `*.manual.json` files last; `_metadata.json` carries service-level `/metadata/keyDictionary` and `/metadata/opAliases`. OpenAPI-sourced providers (Neon, PlanetScale, Stripe, …) patch the **OpenAPI document** upstream of the smithy conversion instead. A patch whose target path is stale (no longer in the model) warns and is skipped; a malformed patch **fails the generator run**.
3. **Generate** — the shared smithy→SDK compiler in `@distilled.cloud/core/codegen` compiles each patched model into an Effect SDK module at `src/services/{service}.ts` plus the barrel.

Consequences:

- **Never edit `src/services/*.ts`** — regeneration overwrites it. Anything wrong in the generated SDK (missing error, wrong request/response schema, misnamed operation or member) is fixed with a JSON Patch (`add`/`remove`/`replace`/`move` on the model) in `patches/{service}/`.
- Patch paths address the **Smithy model**: shape IDs are `com.cloudflare.{service}#Name`, and member names are **wire names** (snake_case). The camelCase TS surface is derived at codegen; `move` ops rename shapes and members.

## The doctrine

Every error a distilled operation can produce in practice MUST be a tagged error in that operation's **type-level** error union. The catch-all classes (`UnknownCloudflareError`, `CloudflareHttpError`, and the status-derived classes like `NotFound`/`BadRequest` that distilled leaves out of the typed union) exist only to *surface* gaps — they are never something alchemy code handles.

**When you hit an unmatched error** (an `UnknownCloudflareError`, or you find yourself wanting to check `CloudflareHttpError.status` or an out-of-union `NotFound`), the fix is ALWAYS a distilled patch, never a catch in alchemy:

1. Note the error's code / status / message from the failure output.
2. Add or extend `submodules/distilled/packages/cloudflare/patches/{service}/{operation}.json` with a JSON Patch that (a) adds an error structure carrying the `smithy.api#error` trait and `com.cloudflare.protocols#errorMatchers` matchers, and (b) attaches it to the operation's `errors` list. Use a **meaningful, resource-specific tag** (e.g. `WidgetNotFound`, not a bare `NotFound`):

   ```json
   {
     "description": "Type the not-found error on getWidget",
     "patches": [
       {
         "op": "add",
         "path": "/shapes/com.cloudflare.widgets#WidgetNotFound",
         "value": {
           "type": "structure",
           "members": {
             "code": { "target": "smithy.api#Integer" },
             "message": { "target": "smithy.api#String" }
           },
           "traits": {
             "smithy.api#error": "client",
             "com.cloudflare.protocols#errorMatchers": [{ "code": 1234 }]
           }
         }
       },
       {
         "op": "add",
         "path": "/shapes/com.cloudflare.widgets#GetWidget/errors",
         "value": [{ "target": "com.cloudflare.widgets#WidgetNotFound" }]
       }
     ]
   }
   ```

   If the operation already has an `errors` array (from an earlier patch), append with `"path": ".../errors/-"` instead of adding the whole array. Matchers may combine `code`, `status`, and `message` (a string, or `{ "includes": "..." }` / `{ "matches": "..." }`) — e.g. `[{ "status": 400, "message": { "includes": "snippet not found" } }]` when Cloudflare misuses 400 for a missing resource. Prefer matching the Cloudflare error `code` when one exists; fall back to `status` + `message` otherwise. The most specific matcher wins; ties break by declaration order.

3. Regenerate ONLY that service: `cd submodules/distilled/packages/cloudflare && bun scripts/generate.ts --resource {service}` (then format: `pnpm exec oxfmt src/services/{service}.ts`). A warned-stale or failed patch is a bug in your patch — fix it; never leave a red generate.
4. Handle the now-typed tag in alchemy code and re-run the tests.

**AWS is the one exception to the JSON Patch format**: it layers typed-error metadata over the official Smithy models with a per-service schema file `submodules/distilled/packages/aws/patches/{service}.json` (error categories, aliases, synthetic errors with message matchers — see `submodules/distilled/packages/aws/scripts/spec-schema.ts`), regenerated with `cd submodules/distilled/packages/aws && bun scripts/generate.ts --sdk {service}`. The doctrine is identical; only the patch dialect differs.

**Forbidden patterns** — these defeat the type system and must never appear in alchemy code or tests:

```ts
// ❌ unknown-typed structural predicates
const isNotFoundError = (e: unknown): boolean =>
  Predicate.hasProperty(e, "_tag") && (e as { _tag: unknown })._tag === "NotFound";

// ❌ widening casts to duck-typed tags
Effect.retry({ while: (e) => (e as { _tag?: string })._tag === "Forbidden" })

// ❌ catching the catch-all HTTP error by status
Effect.catchIf((e) => e._tag === "CloudflareHttpError" && e.status === 404, ...)
```

**Required patterns** — fully inferred, no casts, no `unknown`:

```ts
// ✅ catch a typed tag
.pipe(Effect.catchTag("WidgetNotFound", () => Effect.void))

// ✅ retry while a typed tag is observed (e is the op's inferred error union)
Effect.retry({ while: (e) => e._tag === "WidgetNotFound", schedule, times })

// ✅ multiple tags
Effect.catchTag(["WidgetNotFound", "Gone"], () => Effect.succeed(undefined))
```

If `Effect.catchTag("SomeTag", ...)` fails to typecheck, that is the signal that distilled's union is missing the error — patch distilled (step 2 above); do not loosen the alchemy-side types.
