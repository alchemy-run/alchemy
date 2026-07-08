import * as cloudwatch from "@distilled.cloud/aws/cloudwatch";
import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import * as Layer from "effect/Layer";
import { isFunction } from "../Lambda/Function.ts";
import {
  ListAlarmMuteRules,
  type ListAlarmMuteRulesRequest,
} from "./ListAlarmMuteRules.ts";

export const ListAlarmMuteRulesHttp = Layer.effect(
  ListAlarmMuteRules,
  Effect.gen(function* () {
    const listAlarmMuteRules = yield* cloudwatch.listAlarmMuteRules;

    return Effect.fn(function* () {
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        if (isFunction(host)) {
          yield* host.bind`Allow(${host}, AWS.CloudWatch.ListAlarmMuteRules())`(
            {
              policyStatements: [
                {
                  Effect: "Allow",
                  Action: ["cloudwatch:ListAlarmMuteRules"],
                  Resource: ["*"],
                },
              ],
            },
          );
        }
      }
      return Effect.fn(`AWS.CloudWatch.ListAlarmMuteRules`)(function* (
        request: ListAlarmMuteRulesRequest = {},
      ) {
        return yield* listAlarmMuteRules(request);
      });
    });
  }),
);
