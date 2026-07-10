import { Endpoint } from "@distilled.cloud/aws";
import * as Region from "@distilled.cloud/aws/Region";
import * as sfn from "@distilled.cloud/aws/sfn";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Binding from "../../Binding.ts";
import { isFunction } from "../Lambda/Function.ts";
import type { StateMachine } from "./StateMachine.ts";
import {
  StartSyncExecution,
  type StartSyncExecutionRequest,
} from "./StartSyncExecution.ts";

export const StartSyncExecutionHttp = Layer.effect(
  StartSyncExecution,
  Effect.gen(function* () {
    // `StartSyncExecution` must target the `sync-states.{region}` endpoint
    // (the Smithy `hostPrefix: "sync-"` endpoint trait) — the regular
    // `states.{region}` endpoint rejects it. distilled applies the host
    // prefix itself; the explicit Endpoint here additionally pins the
    // correct host for runtimes bundled against a distilled build that
    // predates host-prefix support.
    const regionEffect = yield* Region.Region;
    const syncStatesEndpoint: Effect.Effect<string | undefined> = Effect.map(
      regionEffect,
      (region) => `https://sync-states.${region}.amazonaws.com`,
    );
    const startSyncExecution = yield* sfn.startSyncExecution.pipe(
      Effect.provideService(Endpoint.Endpoint, syncStatesEndpoint),
    );

    return Effect.fn(function* (stateMachine: StateMachine) {
      const StateMachineArn = yield* stateMachine.stateMachineArn;
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        if (isFunction(host)) {
          yield* host.bind`Allow(${host}, AWS.StepFunctions.StartSyncExecution(${stateMachine}))`(
            {
              policyStatements: [
                {
                  Effect: "Allow",
                  Action: ["states:StartSyncExecution"],
                  Resource: [stateMachine.stateMachineArn],
                },
              ],
            },
          );
        }
      }
      return Effect.fn(
        `AWS.StepFunctions.StartSyncExecution(${stateMachine.LogicalId})`,
      )(function* (request?: StartSyncExecutionRequest) {
        const stateMachineArn = yield* StateMachineArn;
        return yield* startSyncExecution({ ...request, stateMachineArn });
      });
    });
  }),
);
