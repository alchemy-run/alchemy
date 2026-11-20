import { Endpoint } from "@distilled.cloud/aws";
import type { ProviderError } from "@distilled.cloud/aws/Credentials";
import * as Region from "@distilled.cloud/aws/Region";
import * as sfn from "@distilled.cloud/aws/sfn";
import * as Binding from "alchemy/Binding";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { makeStateMachineArnHttpBinding } from "./BindingHttp.ts";
import type { StateMachine } from "./StateMachine.ts";

export interface StartSyncExecutionRequest extends Omit<
  sfn.StartSyncExecutionInput,
  "stateMachineArn"
> {}

/**
 * Runtime binding for `states:StartSyncExecution`.
 *
 * Bind this operation to an `EXPRESS` {@link StateMachine} inside a function
 * runtime to run the workflow synchronously — the call returns once the
 * execution finishes, with its status and output. Not available for
 * `STANDARD` workflows.
 * ### Synchronous Execution
 * **Example:** Run an EXPRESS workflow and read its output
 * ```typescript
 * const startSyncExecution = yield* StepFunctions.StartSyncExecution(machine);
 *
 * const result = yield* startSyncExecution({
 *   input: JSON.stringify({ value: 21 }),
 * });
 * if (result.status === "SUCCEEDED") {
 *   const output = JSON.parse(String(result.output));
 * }
 * ```
 *
 * @binding
 */
export interface StartSyncExecution extends Binding.Service<
  StartSyncExecution,
  "AWS.StepFunctions.StartSyncExecution",
  (
    stateMachine: StateMachine,
  ) => Effect.Effect<
    (
      request?: StartSyncExecutionRequest,
    ) => Effect.Effect<sfn.StartSyncExecutionOutput, sfn.StartSyncExecutionError>
  >
> {}
export const StartSyncExecution = Binding.Service<StartSyncExecution>(
  "AWS.StepFunctions.StartSyncExecution",
);

/**
 * `StartSyncExecution` must target the `sync-states.{region}` endpoint
 * (the Smithy `hostPrefix: "sync-"` endpoint trait) — the regular
 * `states.{region}` endpoint rejects it. distilled applies the host
 * prefix itself; the explicit Endpoint here additionally pins the
 * correct host for runtimes bundled against a distilled build that
 * predates host-prefix support.
 */
const startSyncExecutionOnSyncEndpoint = Effect.gen(function* () {
  const regionEffect = yield* Region.Region;
  // No region: no pin; the call itself then fails with MissingRegion.
  const syncStatesEndpoint: Effect.Effect<string | undefined, ProviderError> = regionEffect.pipe(
    Effect.map((region): string | undefined => `https://sync-states.${region}.amazonaws.com`),
    Effect.catchTag("Alchemy::AWS::MissingRegion", () => Effect.undefined),
  );
  const op = yield* sfn.startSyncExecution;
  // The endpoint must be pinned per call, not around the yield: the
  // yield-time snapshot is only a fallback — the calling fiber's ambient
  // `Endpoint` (e.g. the runtime's `Endpoint.fromEnv`) wins over it.
  return (input: sfn.StartSyncExecutionInput) =>
    op(input).pipe(Effect.provideService(Endpoint.Endpoint, syncStatesEndpoint));
});

export const StartSyncExecutionHttp = Layer.effect(
  StartSyncExecution,
  makeStateMachineArnHttpBinding({
    tag: "AWS.StepFunctions.StartSyncExecution",
    operation: startSyncExecutionOnSyncEndpoint,
    actions: ["states:StartSyncExecution"],
  }),
);
