import * as xray from "@distilled.cloud/aws/xray";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Binding from "../../Binding.ts";
import { isBindingHost } from "../Lambda/Function.ts";
import {
  GetTraceSummaries,
  type GetTraceSummariesRequest,
} from "./GetTraceSummaries.ts";

/**
 * HTTP implementation of the `XRay.GetTraceSummaries` binding.
 *
 * At deploy time it grants `xray:GetTraceSummaries` on `*` to the host Lambda
 * Function (the action does not support resource-level permissions); at
 * runtime it calls the X-Ray API with the function's execution role
 * credentials.
 *
 * @example Provide on the Function effect
 * ```typescript
 * import * as XRay from "alchemy/AWS/XRay";
 *
 * Effect.gen(function* () {
 *   const getTraceSummaries = yield* XRay.GetTraceSummaries();
 *   // ...
 * }).pipe(Effect.provide(XRay.GetTraceSummariesHttp));
 * ```
 */
export const GetTraceSummariesHttp = Layer.effect(
  GetTraceSummaries,
  Effect.gen(function* () {
    const getTraceSummaries = yield* xray.getTraceSummaries;

    return Effect.fn(function* () {
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        if (isBindingHost(host)) {
          yield* host.bind`Allow(${host}, AWS.XRay.GetTraceSummaries())`({
            policyStatements: [
              {
                Effect: "Allow",
                Action: ["xray:GetTraceSummaries"],
                // xray:GetTraceSummaries does not support resource-level
                // permissions.
                Resource: ["*"],
              },
            ],
          });
        }
      }
      return Effect.fn(`AWS.XRay.GetTraceSummaries`)(function* (
        request: GetTraceSummariesRequest,
      ) {
        return yield* getTraceSummaries(request);
      });
    });
  }),
);
