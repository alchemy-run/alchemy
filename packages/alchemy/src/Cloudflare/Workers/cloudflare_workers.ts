import * as Effect from "effect/Effect";

// Defeats static resolution by foreign bundlers: user DO/Workflow modules
// (and the backend they ride in) are compiled by framework builds — kit's
// vite SSR pass, Next/turbopack — where a statically-analyzable
// `import("cloudflare:workers")` is a hard resolve error. The template
// keeps the import a RUNTIME dynamic import everywhere, which is exactly
// the semantics this module already relied on (the finish-pass bundler
// listed `cloudflare:` as external, leaving the same runtime import).
const DO_NOT_BUNDLE = "";

// Start the import at module evaluation (legal since workerd's 2025-03
// importable-env change) so the isolate-lifetime layer build that awaits it
// only ever sees an already-settled promise. This keeps the first event's
// build free of I/O-backed awaits: everything after this is pure layer
// assembly plus scheduler microtasks. Outside workerd (deploy/plan in Node,
// vitest) the import rejects and the fallback stub is used; the `.catch` is
// attached immediately so the rejection is always handled.
const modulePromise: Promise<typeof import("cloudflare:workers")> = import(
  /* @vite-ignore */ `${DO_NOT_BUNDLE}cloudflare:workers`
).catch(
  () =>
    ({
      env: {},
      DurableObject: class {},
      WorkflowEntrypoint: class {
        async run() {}
      },
    }) as any,
);

const cloudflare_workers: Effect.Effect<typeof import("cloudflare:workers")> =
  Effect.promise(() => modulePromise);

export default cloudflare_workers;
