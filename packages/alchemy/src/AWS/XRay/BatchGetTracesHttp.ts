import * as xray from "@distilled.cloud/aws/xray";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Binding from "../../Binding.ts";
import { isFunction } from "../Lambda/Function.ts";
import {
  BatchGetTraces,
  type BatchGetTracesRequest,
} from "./BatchGetTraces.ts";

export const BatchGetTracesHttp = Layer.effect(
  BatchGetTraces,
  Effect.gen(function* () {
    const batchGetTraces = yield* xray.batchGetTraces;

    return Effect.fn(function* () {
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        if (isFunction(host)) {
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
