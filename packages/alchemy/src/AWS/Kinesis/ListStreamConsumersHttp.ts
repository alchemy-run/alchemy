import * as Kinesis from "@distilled.cloud/aws/kinesis";
import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import * as Layer from "effect/Layer";
import { isFunction } from "../Lambda/Function.ts";
import {
  ListStreamConsumers,
  type ListStreamConsumersRequest,
} from "./ListStreamConsumers.ts";
import type { Stream } from "./Stream.ts";

export const ListStreamConsumersHttp = Layer.effect(
  ListStreamConsumers,
  Effect.gen(function* () {
    const listStreamConsumers = yield* Kinesis.listStreamConsumers;

    return Effect.fn(function* (stream: Stream) {
      const StreamARN = yield* stream.streamArn;
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        if (isFunction(host)) {
          yield* host.bind`Allow(${host}, AWS.Kinesis.ListStreamConsumers(${stream}))`(
            {
              policyStatements: [
                {
                  Effect: "Allow",
                  Action: ["kinesis:ListStreamConsumers"],
                  Resource: [stream.streamArn],
                },
              ],
            },
          );
        }
      }
      return Effect.fn(`AWS.Kinesis.ListStreamConsumers(${stream.LogicalId})`)(
        function* (request?: ListStreamConsumersRequest) {
          return yield* listStreamConsumers({
            ...request,
            StreamARN: yield* StreamARN,
          });
        },
      );
    });
  }),
);
