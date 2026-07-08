import * as sns from "@distilled.cloud/aws/sns";
import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import * as Layer from "effect/Layer";
import { isFunction } from "../Lambda/Function.ts";
import {
  ListSubscriptions,
  type ListSubscriptionsRequest,
} from "./ListSubscriptions.ts";

export const ListSubscriptionsHttp = Layer.effect(
  ListSubscriptions,
  Effect.gen(function* () {
    const listSubscriptions = yield* sns.listSubscriptions;

    return Effect.fn(function* () {
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        if (isFunction(host)) {
          yield* host.bind`Allow(${host}, AWS.SNS.ListSubscriptions())`({
            policyStatements: [
              {
                Effect: "Allow",
                Action: ["sns:ListSubscriptions"],
                Resource: ["*"],
              },
            ],
          });
        }
      }
      return Effect.fn(`AWS.SNS.ListSubscriptions`)(function* (
        request?: ListSubscriptionsRequest,
      ) {
        return yield* listSubscriptions(request ?? {});
      });
    });
  }),
);
