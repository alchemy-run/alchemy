import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Effect from "effect/Effect";
import {
  type AsyncPlatformWorkerEnv,
  DispatchNs,
  OutboundDispatch,
  type OutboundParams,
  OutboundWorker,
} from "./fixtures/shared.ts";

// Checked by the type checker (`tsrs -b`), never run: each `@ts-expect-error`
// fails the build if the line it marks compiles.

const outboundTypeChecks = (env: AsyncPlatformWorkerEnv) => {
  Cloudflare.WorkersForPlatforms.Get<OutboundParams>(DispatchNs, {
    outbound: OutboundWorker,
    // @ts-expect-error a parameter name the params type doesn't declare
    parameters: ["tenantt"],
  });
  // @ts-expect-error a params type with no outbound declared
  Cloudflare.WorkersForPlatforms.Get<OutboundParams>(DispatchNs);
  // @ts-expect-error get() on an outbound binding without outbound values
  env.DISPATCH_OUTBOUND.get("script", {});
  // @ts-expect-error an outbound value of the wrong type
  env.DISPATCH_OUTBOUND.get("script", {}, { outbound: { tenant: 1 } });
  // @ts-expect-error an outbound value the params type doesn't declare
  env.DISPATCH_OUTBOUND.get("script", {}, { outbound: { tenant: "acme", plan: "pro" } });
  // @ts-expect-error a declared value left out, which Cloudflare refuses
  env.DISPATCH_OUTBOUND.get("script", {}, { outbound: {} });
  // @ts-expect-error `undefined`, which fails the request (`null` is "no value")
  env.DISPATCH_OUTBOUND.get("script", {}, { outbound: { tenant: undefined } });
  env.DISPATCH_OUTBOUND.get("script", {}, { outbound: { tenant: null } });
  // The plain binding is unchanged: no options, no outbound.
  env.DISPATCH.get("script");
  return Effect.gen(function* () {
    const dispatch = yield* OutboundDispatch;
    // @ts-expect-error the Effect form requires outbound values too
    yield* dispatch.get("script", {});
    yield* dispatch.get("script", {}, { outbound: { tenant: "acme" } });
  });
};

// An optional key of the params type is still required on each dispatch.
const optionalKeyChecks = (
  ns: Cloudflare.WorkersForPlatforms.DispatchNamespaceFor<{ plan?: string }>,
) => {
  // @ts-expect-error an optional key left out
  ns.get("script", {}, { outbound: {} });
  ns.get("script", {}, { outbound: { plan: "pro" } });
};

// Written inline in an `env`, where the env's own type is the contextual one.
const inlinePlain = Cloudflare.Worker("InlinePlain", {
  main: "./worker.ts",
  env: { NS: Cloudflare.WorkersForPlatforms.Get(DispatchNs) },
});
const inlineNoParams = Cloudflare.Worker("InlineNoParams", {
  main: "./worker.ts",
  env: {
    NS: Cloudflare.WorkersForPlatforms.Get(DispatchNs, { outbound: OutboundWorker }),
  },
});
const inlineParams = Cloudflare.Worker("InlineParams", {
  main: "./worker.ts",
  env: {
    NS: Cloudflare.WorkersForPlatforms.Get<OutboundParams>(DispatchNs, {
      outbound: OutboundWorker,
      parameters: ["tenant"],
    }),
  },
});
const inlineUntyped = Cloudflare.Worker("InlineUntyped", {
  main: "./worker.ts",
  env: {
    NS: Cloudflare.WorkersForPlatforms.Get(DispatchNs, {
      outbound: OutboundWorker,
      parameters: ["tenant"],
    }),
  },
});
const inlineVite = Cloudflare.Website.Vite("InlineVite", {
  env: { NS: Cloudflare.WorkersForPlatforms.Get(DispatchNs) },
});

const inlineChecks = (
  plain: Cloudflare.InferEnv<typeof inlinePlain>,
  noParams: Cloudflare.InferEnv<typeof inlineNoParams>,
  params: Cloudflare.InferEnv<typeof inlineParams>,
  untyped: Cloudflare.InferEnv<typeof inlineUntyped>,
) => {
  plain.NS.get("script");
  noParams.NS.get("script");
  // @ts-expect-error the declared value left out
  params.NS.get("script", {});
  params.NS.get("script", {}, { outbound: { tenant: "acme" } });
  // Without a params type, the parameter names are still checked.
  // @ts-expect-error the listed parameter left out
  untyped.NS.get("script", {});
  // @ts-expect-error a name that isn't listed
  untyped.NS.get("script", {}, { outbound: { tenant: "acme", plan: "pro" } });
  untyped.NS.get("script", {}, { outbound: { tenant: "acme" } });
};
