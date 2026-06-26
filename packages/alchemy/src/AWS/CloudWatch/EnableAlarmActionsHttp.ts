import * as cloudwatch from "@distilled.cloud/aws/cloudwatch";
import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import * as Layer from "effect/Layer";
import { isFunction } from "../Lambda/Function.ts";
import { type AlarmResource, sortAlarmResources } from "./binding-common.ts";
import { EnableAlarmActions } from "./EnableAlarmActions.ts";

export const EnableAlarmActionsHttp = Layer.effect(
  EnableAlarmActions,
  Effect.gen(function* () {
    const enableAlarmActions = yield* cloudwatch.enableAlarmActions;

    return Effect.fn(function* (...alarms: AlarmResources) {
      const sorted = sortAlarmResources(alarms);
      const AlarmNames = yield* Effect.forEach(sorted, (alarm) =>
        alarm.alarmName.asEffect(),
      );
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        if (isFunction(host)) {
          yield* host.bind`Allow(${host}, AWS.CloudWatch.EnableAlarmActions(${sorted}))`(
            {
              policyStatements: [
                {
                  Effect: "Allow",
                  Action: ["cloudwatch:EnableAlarmActions"],
                  Resource: sorted.map((alarm) => alarm.alarmArn),
                },
              ],
            },
          );
        }
      }

      return Effect.fn(`AWS.CloudWatch.EnableAlarmActions(${sorted})`)(
        function* () {
          return yield* enableAlarmActions({
            AlarmNames: yield* Effect.forEach(
              AlarmNames,
              (alarmName) => alarmName,
            ),
          });
        },
      );
    });
  }),
);

type AlarmResources = [AlarmResource, ...AlarmResource[]];
