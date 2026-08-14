/**
 * Lazy, non-bundleable imports of the `@alchemy.run/cloudflare-runtime`
 * local-provider/simulator modules.
 *
 * The narrow capability subpaths (`alchemy/Cloudflare/KV`, `.../Queues`,
 * `.../D1`, ...) are value-imported by user Worker code, and foreign
 * bundlers (Turbopack, OpenNext's esbuild pass, webpack) traverse that
 * static graph. The runtime package must never enter it: `workerd`
 * resolves its native binary at module scope and the Images simulator
 * reaches for `sharp` — both unbundleable. The computed specifier defeats
 * static resolution in every bundler; the comments silence the ones that
 * support them. Node/bun resolve the import normally at dev/plan time,
 * the only time these paths execute.
 *
 * NOT exported from `index.ts` — provider/capability-internal scaffolding.
 */
import * as Effect from "effect/Effect";

/** Defeats static resolution of the specifier by foreign bundlers. */
const DO_NOT_BUNDLE = "";

export const importRuntime = Effect.promise(
  (): Promise<typeof import("@alchemy.run/cloudflare-runtime/core")> =>
    import(
      /* @vite-ignore */ /* webpackIgnore: true */
      DO_NOT_BUNDLE + "@alchemy.run/cloudflare-runtime/core"
    ),
);

export const importRuntimeBindings = Effect.promise(
  (): Promise<typeof import("@alchemy.run/cloudflare-runtime/core/bindings")> =>
    import(
      /* @vite-ignore */ /* webpackIgnore: true */
      DO_NOT_BUNDLE + "@alchemy.run/cloudflare-runtime/core/bindings"
    ),
);

export const importRuntimePlatformProxy = Effect.promise(
  (): Promise<
    typeof import("@alchemy.run/cloudflare-runtime/core/platform-proxy")
  > =>
    import(
      /* @vite-ignore */ /* webpackIgnore: true */
      DO_NOT_BUNDLE + "@alchemy.run/cloudflare-runtime/core/platform-proxy"
    ),
);

export const importRuntimeWorkerProxy = Effect.promise(
  (): Promise<
    typeof import("@alchemy.run/cloudflare-runtime/core/proxy/WorkerProxy")
  > =>
    import(
      /* @vite-ignore */ /* webpackIgnore: true */
      DO_NOT_BUNDLE + "@alchemy.run/cloudflare-runtime/core/proxy/WorkerProxy"
    ),
);

export const importRuntimeD1Options = Effect.promise(
  (): Promise<
    typeof import("@alchemy.run/cloudflare-runtime/core/bindings/d1/D1Options")
  > =>
    import(
      /* @vite-ignore */ /* webpackIgnore: true */
      DO_NOT_BUNDLE +
        "@alchemy.run/cloudflare-runtime/core/bindings/d1/D1Options"
    ),
);
