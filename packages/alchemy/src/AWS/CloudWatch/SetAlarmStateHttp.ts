import * as cloudwatch from "@distilled.cloud/aws/cloudwatch";
import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import * as Layer from "effect/Layer";
import { isFunction } from "../Lambda/Function.ts";
import type { AlarmResource } from "./binding-common.ts";
import { SetAlarmState, type SetAlarmStateRequest } from "./SetAlarmState.ts";

export const SetAlarmStateHttp = Layer.effect(
  SetAlarmState,
  Effect.gen(function* () {
    const setAlarmState = yield* cloudwatch.setAlarmState;

    return Effect.fn(function* (alarm: AlarmResource) {
      const AlarmName = yield* alarm.alarmName;
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        if (isFunction(host)) {
          yield* host.bind`Allow(${host}, AWS.CloudWatch.SetAlarmState(${alarm}))`(
            {
              policyStatements: [
                {
                  Effect: "Allow",
                  Action: ["cloudwatch:SetAlarmState"],
                  Resource: [alarm.alarmArn],
                },
              ],
            },
          );
        }
      }
      return Effect.fn(`AWS.CloudWatch.SetAlarmState(${alarm.LogicalId})`)(
        function* (request: SetAlarmStateRequest) {
          return yield* setAlarmState({
            ...request,
            AlarmName: yield* AlarmName,
          });
        },
      );
    });
  }),
);
