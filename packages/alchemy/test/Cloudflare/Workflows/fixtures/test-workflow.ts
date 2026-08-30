import * as Cloudflare from "@/Cloudflare";
import * as Effect from "effect/Effect";

/**
 * Fixture workflow used by `Workflow.local.test.ts`.
 *
 * Minimal durable body: one named `task`, a short `sleep`, and event
 * metadata in the result — enough to prove the workflow engine (local
 * workerd emulation or real Cloudflare) actually ran the instance.
 *
 * The two partially-configured steps are a regression guard, not filler. See
 * `retry-only` below.
 */
export default class LocalTestWorkflow extends Cloudflare.Workflow<LocalTestWorkflow>()(
  "LocalTestWorkflow",
  Effect.gen(function* () {
    return Effect.fn(function* (input: { value: string }) {
      const event = yield* Cloudflare.Workflows.WorkflowEvent;

      const greeted = yield* Cloudflare.Workflows.task(
        "greet",
        Effect.succeed({ text: `Hello, ${input.value}!` }),
      );

      /**
       * `retries` with no `timeout` — the case that used to break every
       * workflow that set a retry policy.
       *
       * `toWorkflowStepConfig` emitted `{ retries, timeout: options.timeout }`
       * unconditionally, so this step arrived at the engine carrying an own
       * `timeout` property whose value was `undefined`. The engine merges a step
       * config over its defaults by spread, and an own `undefined` still wins a
       * spread, so its `timeout: "10 minutes"` became `undefined` — which it
       * then parsed with itty-time's `e.match(/…/)` and died on with
       * `Cannot read properties of undefined (reading 'match')`.
       *
       * Nothing about that failure points here. The parse runs in the step's
       * timeout race rather than gating the body, so the body succeeds on every
       * attempt and the instance errors only afterwards, naming a file the user
       * never wrote. Every pre-existing fixture passed both options or neither,
       * which is precisely why it shipped.
       */
      const retried = yield* Cloudflare.Workflows.task(
        "retry-only",
        Effect.succeed({ ok: true }),
        { retries: { limit: 2, delay: "1 second" } },
      );

      /**
       * The mirror: `timeout` with no `retries`. Survivable even before the fix,
       * because the engine rebuilds `retries` from its defaults with an explicit
       * key *after* the spread — but it was the same mistake, and pinning it
       * stops the asymmetry from being re-introduced as a "harmless" shortcut.
       */
      const bounded = yield* Cloudflare.Workflows.task(
        "timeout-only",
        Effect.succeed({ ok: true }),
        { timeout: "30 seconds" },
      );

      yield* Cloudflare.Workflows.sleep("cooldown", "1 second");

      return {
        greeting: greeted.text,
        retriedOk: retried.ok,
        boundedOk: bounded.ok,
        workflowName: event.workflowName,
        instanceId: event.instanceId,
      };
    });
  }),
) {}
