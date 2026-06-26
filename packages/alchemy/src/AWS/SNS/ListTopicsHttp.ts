import * as sns from "@distilled.cloud/aws/sns";
import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import * as Layer from "effect/Layer";
import { isFunction } from "../Lambda/Function.ts";
import { ListTopics, type ListTopicsRequest } from "./ListTopics.ts";

export const ListTopicsHttp = Layer.effect(
  ListTopics,
  Effect.gen(function* () {
    const listTopics = yield* sns.listTopics;

    return Effect.fn(function* () {
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        if (isFunction(host)) {
          yield* host.bind`Allow(${host}, AWS.SNS.ListTopics())`({
            policyStatements: [
              {
                Effect: "Allow",
                Action: ["sns:ListTopics"],
                Resource: ["*"],
              },
            ],
          });
        }
      }
      return Effect.fn(`AWS.SNS.ListTopics`)(function* (
        request?: ListTopicsRequest,
      ) {
        return yield* listTopics(request ?? {});
      });
    });
  }),
);
