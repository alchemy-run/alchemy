import * as Context from "effect/Context";

/**
 * Opt-in switch for the test-logging pipeline, read by the Cloudflare
 * Worker provider during diff/reconcile. A `Context.Reference` so it
 * defaults to `false` everywhere (CLI deploys never see it) and the test
 * harness can flip it on for a whole deploy with a single
 * `Effect.provideService` — no fixture/stack changes required.
 */
export const TestLoggingPolicy = Context.Reference<boolean>(
  "alchemy/Cloudflare/TestLoggingPolicy",
  { defaultValue: () => false },
);
