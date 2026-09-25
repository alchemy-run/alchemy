// `Cloudflare.Container` did not expose `ref`.
//
// Every factory-built / Platform-built resource gets `ref` from the
// `ResourceClass` `Platform` builds internally (see Platform.ts:691-704:
// `instance = Object.assign(constructor, resource, …)` and `resource` is a
// `ResourceClass` whose `Service` carries `ref` — see Resource.ts:534-538):
//
//   const bucket = Cloudflare.R2.Bucket.ref("Bucket", { stack: "my-stack" });
//
// `Container` is hand-assembled rather than built through `Platform(...)` —
// every other effect-native resource (`Worker`, `Railway.Service`,
// `Fly.Service`, `AWS.Lambda.Function`, …) is. The hand-written wrapper
// `Object.assign`ed only `{ Type }` and never spread the `ResourceClass` that
// `ContainerPlatform` builds, so `.ref` was absent from both the value and
// the type. The structural fix spreads `ContainerPlatform` onto the static
// `Container` value, so `ref` (and `Type`, `Provider`, `Self`, `Aliases`,
// `bind`) come for free — same shape `Worker` gets by being
// `Platform(...)` directly. The custom dispatcher survives because the
// per-id return values carry Container-specific markers
// (`~alchemy/Container/Binding`, `~alchemy/Container/ClassName`,
// `~alchemy/Container/Shape`, `Application`) that `Platform`'s generic
// constructor does not add.
//
// Cross-stack references are what let a program be split into a master stack
// plus per-service slices. A Container cannot be bound onto a Worker in a
// stack that does not own the application (the DO binding has to be
// declared on a Worker in the stack that owns the container application),
// so the practical value of `Container.ref` is limited to reading the
// application's outputs and ordering deploys against it — not binding. See
// the issue body for the full motivation.
//
// The regression is a type-level one (the runtime helper is generic), so
// these assertions fail to compile without the fix rather than failing at
// run time. Each `_Foo` type alias is intentionally a no-op export so the
// compiler evaluates it; `Equals` is the standard TS type-equality
// assertion.
//
// `Effect.runSync` is used in place of `Effect.runPromise` for the runtime
// tests: `runPromise` schedules on Bun's microtask queue and an `Output`
// proxy returned as the resolved value appears to interact poorly with the
// test runner's async wrapping. `runSync` resolves the same Effect on the
// current tick, which is sufficient because the Effect is
// `Effect.succeed(Output.of(refProxy))` — no async work to schedule.
import * as Cloudflare from "@/Cloudflare";
import { describe, expect, test } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Output from "@/Output.ts";

type Assert<T extends true> = T;
type Equals<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
    ? true
    : false;

/** `.ref` must exist on the static value. */
type _HasRef = Assert<
  typeof Cloudflare.Container extends {
    ref(
      id: string,
      options?: { stage?: string; stack?: string },
    ): Effect.Effect<unknown>;
  }
    ? true
    : false
>;

/** And it must accept the cross-stack options, i.e. be usable from a slice. */
type _AcceptsStack = Assert<
  Parameters<typeof Cloudflare.Container.ref>[1] extends
    | { stack?: string; stage?: string }
    | undefined
    ? true
    : false
>;

/** The Effect resolves to the same shape the resource itself has —
 *  `ContainerApplication` — so downstream code can read attributes
 *  (`ref.someAttr`) the way it would for a locally-declared resource. */
type _ResolvesToContainerApplication = Assert<
  Equals<
    Effect.Success<ReturnType<typeof Cloudflare.Container.ref>>,
    Cloudflare.Containers.ContainerApplication
  >
>;

/** A ref carries no `env`/`Bindings` payload (unlike a live declaration). */
type _ReferenceHasNoEnv = Assert<
  Equals<
    Extract<
      "env",
      keyof Effect.Success<ReturnType<typeof Cloudflare.Container.ref>>
    >,
    never
  >
>;

describe("Cloudflare.Container.ref", () => {
  test("builds a reference without touching the account", () => {
    // Constructing the ref is pure: it only records the target stack/stage and
    // logical id, so this needs no provider and no credentials.
    const reference = Cloudflare.Container.ref("App", { stack: "other" });
    expect(Effect.isEffect(reference)).toBe(true);
  });

  test("resolves to an Output that the planner routes as a RefExpr", () => {
    // `Container.ref(...)` returns `Effect.succeed(Output.of(refProxy))`,
    // so `Effect.runSync` produces a `RefExpr` (Output.ts:410) — the same
    // shape every other `X.ref(...)` produces. The planner checks
    // `Output.isRefExpr` (Plan.ts:965) to route cross-stack lookups
    // through state-store resolution; losing it would silently fall back
    // to a same-stack resolution, which is the failure the fix prevents.
    const output = Effect.runSync(
      Cloudflare.Container.ref("App", { stack: "master", stage: "prod" }),
    );
    expect(Output.isOutput(output)).toBe(true);
    expect(Output.isRefExpr(output)).toBe(true);
  });

  test("reference metadata round-trips through Output properties", () => {
    // The `RefExpr` proxy exposes its stack/stage/resourceId as own
    // properties (Output.ts:412-425). `stables` carries the static
    // LogicalId + Type so duck-typing classifiers (Worker env bindings,
    // capability helpers) identify the ref exactly like a locally-declared
    // resource.
    const output = Effect.runSync(
      Cloudflare.Container.ref("App", { stack: "master", stage: "prod" }),
    ) as any;
    expect(output.resourceId).toBe("App");
    expect(output.stack).toBe("master");
    expect(output.stage).toBe("prod");
    expect(output.stables?.LogicalId).toBe("App");
    expect(output.stables?.Type).toBe("Cloudflare.Container");
  });

  test("reference metadata defaults to current stack/stage", () => {
    // When options are omitted the ref points at the current stack/stage —
    // same contract as Worker.ref / Bucket.ref. The proxy surfaces
    // `stack`/`stage` as `undefined` (not absent) so consumers can rely on
    // a stable shape.
    const output = Effect.runSync(Cloudflare.Container.ref("App")) as any;
    expect(output.resourceId).toBe("App");
    expect(output.stack).toBeUndefined();
    expect(output.stage).toBeUndefined();
    expect(output.stables?.Type).toBe("Cloudflare.Container");
  });

  test("same shape as Worker.ref — Bucket and Worker parity check", () => {
    // Sanity: Bucket.ref and Worker.ref (which have always worked) produce
    // the same shape. The structural fix on Container makes Container.ref
    // produce the same shape too.
    const bucket = Effect.runSync(Cloudflare.R2.Bucket.ref("X")) as any;
    const worker = Effect.runSync(Cloudflare.Worker.ref("X")) as any;
    const container = Effect.runSync(Cloudflare.Container.ref("X")) as any;
    expect(bucket.kind).toBe("RefExpr");
    expect(worker.kind).toBe("RefExpr");
    expect(container.kind).toBe("RefExpr");
  });
});
