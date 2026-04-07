import type * as cf from "@cloudflare/workers-types";
import * as Effect from "effect/Effect";

const cloudflare_workers: Effect.Effect<{
  DurableObject: new (
    state: cf.DurableObjectState,
    env: any,
  ) => cf.DurableObject;
  WorkflowEntrypoint: abstract new (
    ctx: unknown,
    env: unknown,
  ) => { run(event: any, step: any): Promise<unknown> };
  env: Record<string, any>;
}> = /** @__PURE__ #__PURE__ */ Effect.promise(() =>
  // @ts-expect-error
  import("cloudflare:workers").catch(() => ({
    env: {},
    DurableObject: class {},
    WorkflowEntrypoint: class {
      async run() {}
    },
  })),
);

export default cloudflare_workers;
