Fixes #1752.

## What

`Cloudflare.Container.ref` is missing from both the declared type and the runtime value, so a container cannot be referenced from another stack:

```ts
Cloudflare.Container.ref("App", { stack: "my-master-stack" })

// before
// TS2339: Property 'ref' does not exist on type
//   'ResourceClassLike<ContainerApplication> & { <DOShape, Id, PropsReq>(…): Decl<…> }'
// and at runtime: TypeError: Cloudflare.Container.ref is not a function
```

This adds `ref` (and the rest of the canonical `ResourceClass` static surface — `Type`, `Provider`, `Self`, `Aliases`) by spreading `ContainerPlatform` onto the static `Container` value. The custom dispatcher survives unchanged.

## Why it matters

Cross-stack references are what let a program be split into a master stack plus per-service slices — the documented "reference another stack" pattern, available on `R2.Bucket`, `D1.Database`, `KV.Namespace` and `Worker`:

```ts
const bucket = Cloudflare.R2.Bucket.ref("Bucket", { stack: "my-master-stack" });
```

A container is the resource for which the *usual workaround is unavailable*:

- A Durable Object binding has to be declared on a Worker in the stack that owns the container application, so a stack holding a Container is necessarily where every Worker that binds it must live. There is no "declare it in the other stack instead".
- Without a reference, that other stack cannot reach the application at all.

So once a Container is involved, the split either cannot be expressed, or the Containers all stay in the largest stack (defeating the point). That is the practical consequence, and it is why this is worth fixing rather than documenting.

## Why a structural fix instead of a literal `ref` member

Every other effect-native resource (`Worker`, `Railway.Service`, `Fly.Service`, `AWS.Lambda.Function`, …) is built directly by `Platform(...)`. `Platform` internally calls `Resource(type, ...)` and spreads the resulting `ResourceClass` onto its return value (Platform.ts:691-704: `instance = Object.assign(constructor, resource, …)`), so `ref`, `Type`, `Provider`, `Self`, `Aliases` all come for free — `Resource.ref` lives on `ResourceClass.Service` (Resource.ts:534-538).

`Container` is hand-assembled rather than built through `Platform(...)`. The hand-written wrapper `Object.assign`ed only `{ Type }` and never spread the `ResourceClass` that `ContainerPlatform` builds, so `.ref` was absent from both the value and the type.

The two natural fixes:

1. **`Object.assign(myDispatcher, { Type, ref: … })`** — what an earlier draft of this PR did. Mirrors `Resource.ref` literally. Works, but encodes the duplication that the missing `ref` exposed: every hand-assembled resource would have to copy the same `ref` literal.

2. **`Object.assign(myDispatcher, ContainerPlatform)`** — what this patch does. Spreads `ContainerPlatform` (which is `Platform(...)` and already carries `ref` via `resource`). Same shape `Worker` gets by being `Platform(...)` directly. The custom dispatcher survives because the per-id return values carry Container-specific markers (`~alchemy/Container/Binding`, `~alchemy/Container/ClassName`, `~alchemy/Container/Shape`, `Application`) that `Platform`'s generic constructor does not add.

The alternative one-liner that mirrors `Worker`'s declaration

```ts
Pick<ResourceClass<ContainerApplication>, "ref"> &
```

does not work alone: type-only. Verified by checking out the pre-PR `Container.ts`, adding the `Pick<>` to the declared intersection, and running `ContainerRef.test.ts` — `tsc --noEmit` passes, the test fails at runtime (`TypeError: Cloudflare.Container.ref is not a function`). The runtime `Container` value needs `ref` to actually be on it, and `Platform(...)` is what attaches it.

## Tests

`packages/alchemy/test/Cloudflare/Containers/ContainerRef.test.ts`:

- `_HasRef`, `_AcceptsStack`, `_ResolvesToContainerApplication`, `_ReferenceHasNoEnv` — type-level assertions that fail to compile without the fix
- 5 behavioural checks: `Effect.isEffect` shape, `Output.isRefExpr` route, `resourceId` / `stack` / `stage` / `stables.LogicalId` / `stables.Type` round-trip, defaults when options are omitted, parity with `Worker.ref` and `Bucket.ref`

Each `_Foo` type alias is intentionally a no-op export so the compiler evaluates it. `Equals` is the standard TS type-equality assertion.

## Scope note

I checked `Cloudflare.Container` as declared for an image/context container (the `.main`/`.image` path) and the effect-native `.make()` Layer variant. Both work after the fix — three integration tests in `Container.test.ts` (remote image, env threading, request proxying through the DO) pass; failures in that file during local development were `Unauthorized` (token permissions), not related to this change.
