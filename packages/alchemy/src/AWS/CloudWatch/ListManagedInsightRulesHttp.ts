import * as cloudwatch from "@distilled.cloud/aws/cloudwatch";
import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import * as Layer from "effect/Layer";
import { isFunction } from "../Lambda/Function.ts";
import {
  ListManagedInsightRules,
  type ListManagedInsightRulesRequest,
} from "./ListManagedInsightRules.ts";

export const ListManagedInsightRulesHttp = Layer.effect(
  ListManagedInsightRules,
  Effect.gen(function* () {
    const listManagedInsightRules = yield* cloudwatch.listManagedInsightRules;

    return Effect.fn(function* () {
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        if (isFunction(host)) {
          yield* host.bind`Allow(${host}, AWS.CloudWatch.ListManagedInsightRules())`(
            {
              policyStatements: [
                {
                  Effect: "Allow",
                  Action: ["cloudwatch:ListManagedInsightRules"],
                  Resource: ["*"],
                },
              ],
            },
          );
        }
      }
      return Effect.fn(`AWS.CloudWatch.ListManagedInsightRules`)(function* (
        request: ListManagedInsightRulesRequest = {},
      ) {
        return yield* listManagedInsightRules(request);
      });
    });
  }),
);
