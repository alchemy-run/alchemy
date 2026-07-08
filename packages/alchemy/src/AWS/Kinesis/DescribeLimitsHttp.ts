import * as Kinesis from "@distilled.cloud/aws/kinesis";
import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import * as Layer from "effect/Layer";
import { isFunction } from "../Lambda/Function.ts";
import {
  DescribeLimits,
  type DescribeLimitsRequest,
} from "./DescribeLimits.ts";

export const DescribeLimitsHttp = Layer.effect(
  DescribeLimits,
  Effect.gen(function* () {
    const describeLimits = yield* Kinesis.describeLimits;

    return Effect.fn(function* () {
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        if (isFunction(host)) {
          yield* host.bind`Allow(${host}, AWS.Kinesis.DescribeLimits())`({
            policyStatements: [
              {
                Effect: "Allow",
                Action: ["kinesis:DescribeLimits"],
                Resource: ["*"],
              },
            ],
          });
        }
      }
      return Effect.fn(`AWS.Kinesis.DescribeLimits`)(function* (
        request?: DescribeLimitsRequest,
      ) {
        return yield* describeLimits(request ?? {});
      });
    });
  }),
);
