import type * as cf from "@cloudflare/workers-types";
import * as Effect from "effect/Effect";

const cloudflare_workers: Effect.Effect<{
  DurableObject: new (
    state: cf.DurableObjectState,
    env: any,
  ) => cf.DurableObject;
  env: Record<string, any>;
}> = /** @__PURE__ #__PURE__ */ Effect.promise(() =>
  // @ts-expect-error
  import("cloudflare:workers").catch(() => ({
    env: {},
    // stub
    DurableObject: class {},
  })),
);

export default cloudflare_workers;
