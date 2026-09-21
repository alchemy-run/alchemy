## Summary

`Cloudflare.Container.ref` is missing from both the declared type and the runtime value, so a container cannot be referenced from another stack:

```ts
Cloudflare.Container.ref("App", { stack: "my-master-stack" })

// TS2339: Property 'ref' does not exist on type
//   'ResourceClassLike<ContainerApplication> & { <DOShape, Id, PropsReq>(…): Decl<…> }'
// and at runtime: TypeError: Cloudflare.Container.ref is not a function
```

## Why this matters

Cross-stack references are what let a program be split into a master stack plus per-service slices — the documented "reference another stack" pattern, available on `R2.Bucket`, `D1.Database`, `KV.Namespace` and `Worker`:

```ts
const bucket = Cloudflare.R2.Bucket.ref("Bucket", { stack: "my-master-stack" });
```

A container is the resource for which the *usual workaround is unavailable*:

- A Durable Object binding has to be declared on a Worker in the stack that owns the container application, so a stack holding a Container is necessarily where every Worker that binds it must live. There is no "declare it in the other stack instead".
- Without a reference, that other stack cannot reach the application at all.

So once a Container is involved, the recommended layout either cannot be expressed, or the Containers all stay in the largest stack — defeating the point of the split.

## Cause

`Cloudflare.Container` is hand-assembled rather than built through `Platform(...)` — every other effect-native resource (`Worker`, `Railway.Service`, `Fly.Service`, `AWS.Lambda.Function`, …) is. The hand-written wrapper `Object.assign`ed only `{ Type }` and never spread the `ResourceClass` that `ContainerPlatform` builds.

`Platform` internally calls `Resource(type, ...)` and spreads the resulting `ResourceClass` onto its return value (Platform.ts:691-704: `instance = Object.assign(constructor, resource, …)`), so `ref`, `Type`, `Provider`, `Self`, `Aliases` all come for free — `Resource.ref` lives on `ResourceClass.Service` (Resource.ts:534-538). `ContainerPlatform` does get all of this; the static `Cloudflare.Container` value just doesn't.

## Fix

Spread `ContainerPlatform` onto the static `Container` value instead of `Object.assign`-ing `{ Type }` literally. The custom dispatcher survives unchanged because the per-id return values carry Container-specific markers (`~alchemy/Container/Binding`, `~alchemy/Container/ClassName`, `~alchemy/Container/Shape`, `Application`) that `Platform`'s generic constructor doesn't add.

The one-liner `Pick<ResourceClass<ContainerApplication>, "ref"> &` (the form `Worker` uses) does not work alone: type-only. Verified by checking out the pre-PR `Container.ts`, adding the `Pick<>` to the declared intersection, and running `ContainerRef.test.ts` — `tsc --noEmit` passes, the test fails at runtime (`TypeError: Cloudflare.Container.ref is not a function`).

## Scope

Both Container declaration paths verified: image/context (the `.main`/`.image` form) and effect-native `.make()` Layer variant. Three integration tests in `Container.test.ts` (remote image, env threading, request proxying through the DO) pass after the fix.
