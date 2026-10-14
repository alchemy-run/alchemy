import * as Effect from "effect/Effect";
import type * as Layer from "effect/Layer";
import * as AI from "@/AI/index.ts";
import * as Cloudflare from "@/Cloudflare";

type Assert<T extends true> = T;
type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;

class Sandbox extends AI.Sandbox<Sandbox, { size: "small" | "large" }>()("SandboxTypes") {}

const program = Effect.succeed({});

// Every declared size maps to an instance type.
export const hosted = Cloudflare.Containers.Sandbox(
  Sandbox,
  { main: "./sandbox.ts", sizes: { small: "lite", large: "standard-4" } },
  program,
);

export const missing = Cloudflare.Containers.Sandbox(
  Sandbox,
  // @ts-expect-error Property 'large' is missing
  { main: "./sandbox.ts", sizes: { small: "lite" } },
  program,
);

export const extra = Cloudflare.Containers.Sandbox(
  Sandbox,
  {
    main: "./sandbox.ts",
    // @ts-expect-error 'huge' is not a declared size
    sizes: { small: "lite", large: "standard-4", huge: "standard-4" },
  },
  program,
);

export const unknownInstance = Cloudflare.Containers.Sandbox(
  Sandbox,
  // @ts-expect-error not a Cloudflare Container instance type
  { main: "./sandbox.ts", sizes: { small: "lite", large: "enormous" } },
  program,
);

// The host is what `yield* Sandbox` needs.
type _HostSatisfiesYield = Assert<
  Equal<typeof hosted, Layer.Layer<AI.Sandbox.Host<Sandbox>, never, Cloudflare.Providers>>
>;
type _YieldNeedsHost = Assert<Equal<Effect.Services<typeof Sandbox>, AI.Sandbox.Host<Sandbox>>>;

export const usage = Effect.gen(function* () {
  const sandbox = yield* Sandbox;
  // start() only takes declared sizes.
  yield* sandbox.start({ size: "large" });
  // @ts-expect-error 'medium' is not a declared size
  yield* sandbox.start({ size: "medium" });
  // @ts-expect-error a size is required
  yield* sandbox.start({});
  type _Size = Assert<Equal<AI.SandboxSize<typeof Sandbox>, "small" | "large">>;
});
