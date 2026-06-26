import * as Kinesis from "@distilled.cloud/aws/kinesis";
import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import * as Layer from "effect/Layer";
import { isFunction } from "../Lambda/Function.ts";
import { ListStreams, type ListStreamsRequest } from "./ListStreams.ts";

export const ListStreamsHttp = Layer.effect(
  ListStreams,
  Effect.gen(function* () {
    const listStreams = yield* Kinesis.listStreams;

    return Effect.fn(function* () {
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        if (isFunction(host)) {
          yield* host.bind`Allow(${host}, AWS.Kinesis.ListStreams())`({
            policyStatements: [
              {
                Effect: "Allow",
                Action: ["kinesis:ListStreams"],
                Resource: ["*"],
              },
            ],
          });
        }
      }
      return Effect.fn(`AWS.Kinesis.ListStreams`)(function* (
        request?: ListStreamsRequest,
      ) {
        return yield* listStreams(request ?? {});
      });
    });
  }),
);
