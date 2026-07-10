import * as xray from "@distilled.cloud/aws/xray";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Binding from "../../Binding.ts";
import { isBindingHost } from "../Lambda/Function.ts";
import {
  GetTraceSummaries,
  type GetTraceSummariesRequest,
} from "./GetTraceSummaries.ts";

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
