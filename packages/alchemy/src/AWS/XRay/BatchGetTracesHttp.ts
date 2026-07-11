import * as xray from "@distilled.cloud/aws/xray";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Binding from "../../Binding.ts";
import { isBindingHost } from "../Lambda/Function.ts";
import {
  BatchGetTraces,
  type BatchGetTracesRequest,
} from "./BatchGetTraces.ts";

/**
 * HTTP implementation of the `XRay.BatchGetTraces` binding.
 *
 * At deploy time it grants `xray:BatchGetTraces` on `*` to the host Lambda
 * Function (the action does not support resource-level permissions); at
 * runtime it calls the X-Ray API with the function's execution role
 * credentials.
 *
 * @example Provide on the Function effect
 * ```typescript
 * import * as XRay from "alchemy/AWS/XRay";
 *
 * Effect.gen(function* () {
 *   const batchGetTraces = yield* XRay.BatchGetTraces();
 *   // ...
 * }).pipe(Effect.provide(XRay.BatchGetTracesHttp));
 * ```
 */
export const BatchGetTracesHttp = Layer.effect(
  BatchGetTraces,
  Effect.gen(function* () {
    const batchGetTraces = yield* xray.batchGetTraces;

    return Effect.fn(function* () {
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        if (isBindingHost(host)) {
          yield* host.bind`Allow(${host}, AWS.XRay.BatchGetTraces())`({
            policyStatements: [
              {
                Effect: "Allow",
                Action: ["xray:BatchGetTraces"],
                // xray:BatchGetTraces does not support resource-level
                // permissions.
                Resource: ["*"],
              },
            ],
          });
        }
      }
      return Effect.fn(`AWS.XRay.BatchGetTraces`)(function* (
        request: BatchGetTracesRequest,
      ) {
        return yield* batchGetTraces(request);
      });
    });
  }),
);
