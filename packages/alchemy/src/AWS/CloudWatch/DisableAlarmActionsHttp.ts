import * as cloudwatch from "@distilled.cloud/aws/cloudwatch";
import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import * as Layer from "effect/Layer";
import { isFunction } from "../Lambda/Function.ts";
import { type AlarmResource, sortAlarmResources } from "./binding-common.ts";
import { DisableAlarmActions } from "./DisableAlarmActions.ts";

export const DisableAlarmActionsHttp = Layer.effect(
  DisableAlarmActions,
  Effect.gen(function* () {
    const disableAlarmActions = yield* cloudwatch.disableAlarmActions;

    return Effect.fn(function* (...alarms: AlarmResources) {
      const sorted = sortAlarmResources(alarms);
      const AlarmNames = yield* Effect.forEach(sorted, (alarm) =>
        alarm.alarmName.asEffect(),
      );
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        if (isFunction(host)) {
          yield* host.bind`Allow(${host}, AWS.CloudWatch.DisableAlarmActions(${sorted}))`(
            {
              policyStatements: [
                {
                  Effect: "Allow",
                  Action: ["cloudwatch:DisableAlarmActions"],
                  Resource: sorted.map((alarm) => alarm.alarmArn),
                },
              ],
            },
          );
        }
      }
      return Effect.fn(`AWS.CloudWatch.DisableAlarmActions(${sorted})`)(
        function* () {
          return yield* disableAlarmActions({
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
