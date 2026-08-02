import * as Effect from "effect/Effect";
import type * as Schedule from "effect/Schedule";
import { makeLocalState } from "./LocalState.ts";
import type { StateService, StateStoreError } from "./State.ts";

/**
 * Shared machinery for state-store bootstrap flows: a state store whose
 * own infrastructure is deployed as an alchemy stack. The stack is first
 * deployed against the *local* state store (the remote store does not
 * exist yet), then its state is hoisted into the store it just created,
 * and the local copy is deleted. See the Cloudflare state store
 * (`Cloudflare/StateStore/State.ts`) and the AWS S3 state store
 * (`AWS/StateStore/Bootstrap.ts`) for the two concrete flows.
 */

/**
 * Whether an interrupted bootstrap left the given stack behind in the
 * local state store — i.e. the deploy ran but the hoist (or the local
 * cleanup after it) did not complete. Callers use this to finish the
 * bootstrap instead of starting a fresh one.
 */
export const hasLocalBootstrapStack = (stack: string, stage: string) =>
  Effect.gen(function* () {
    const localState = yield* makeLocalState();
    return yield* Effect.map(
      localState.listStages(stack),
      // key off the profile name to avoid conflicts with other profiles
      (stages) => stages.includes(stage),
    );
  });

/**
 * Non-destructively copy every resource in the `{stack}/{source.stage}`
 * stack from `source` into `destination`, leaving every other stack in
 * `destination` untouched.
 *
 * This intentionally does not delete anything from `destination`: at
 * bootstrap time the destination is the user's live remote state
 * store, and removing entries that happen to be missing locally would
 * be catastrophic.
 */
export const hoistBootstrapStack = Effect.fn(function* ({
  stack,
  source,
  destination,
  retry,
}: {
  stack: string;
  source: {
    state: StateService;
    stage: string;
  };
  destination: {
    state: StateService;
    stage: string;
  };
  /**
   * Optional retry policy for destination writes — e.g. a freshly
   * deployed HTTP store can serve transient 404/401/5xx while its
   * deployment propagates.
   */
  retry?: {
    while: (error: StateStoreError) => boolean;
    schedule: Schedule.Schedule<unknown, unknown>;
  };
}) {
  const fqns = yield* source.state.list({ stack, stage: source.stage });
  yield* Effect.annotateCurrentSpan({
    "alchemy.state_store.stack": stack,
    "alchemy.state_store.stage": source.stage,
    "alchemy.state_store.resources.count": fqns.length,
  });
  yield* Effect.forEach(
    fqns,
    Effect.fn(function* (fqn) {
      const value = yield* source.state.get({
        stack,
        stage: source.stage,
        fqn,
      });
      if (value) {
        const write = destination.state.set({
          stack,
          stage: destination.stage,
          fqn,
          value,
        });
        yield* retry ? write.pipe(Effect.retry(retry)) : write;
      }
    }),
    { concurrency: "unbounded" },
  );
}, Effect.withSpan("state_store.hoist_bootstrap_stack"));
