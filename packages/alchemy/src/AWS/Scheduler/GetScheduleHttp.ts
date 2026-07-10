import * as scheduler from "@distilled.cloud/aws/scheduler";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Binding from "../../Binding.ts";
import * as Output from "../../Output.ts";
import { AWSEnvironment } from "../Environment.ts";
import { isBindingHost } from "../Lambda/Function.ts";
import { GetSchedule, type GetScheduleRequest } from "./GetSchedule.ts";
import type { ScheduleGroup } from "./ScheduleGroup.ts";

export const GetScheduleHttp = Layer.effect(
  GetSchedule,
  Effect.gen(function* () {
    const getSchedule = yield* scheduler.getSchedule;

    return Effect.fn(function* (group?: ScheduleGroup) {
      const GroupName = group ? yield* group.scheduleGroupName : undefined;
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        if (isBindingHost(host)) {
          const { accountId, region } =
            yield* AWSEnvironment.current as unknown as Effect.Effect<{
              accountId: string;
              region: string;
            }>;
          // Dynamic schedules are named at runtime; the group (or the default
          // group) is the least-privilege boundary.
          const scheduleArnPattern = group
            ? Output.interpolate`arn:aws:scheduler:${region}:${accountId}:schedule/${group.scheduleGroupName}/*`
            : (`arn:aws:scheduler:${region}:${accountId}:schedule/default/*` as const);

          yield* host.bind`Allow(${host}, AWS.Scheduler.GetSchedule(${group ?? "default"}))`(
            {
              policyStatements: [
                {
                  Effect: "Allow",
                  Action: ["scheduler:GetSchedule"],
                  Resource: [scheduleArnPattern],
                },
              ],
            },
          );
        }
      }
      return Effect.fn(
        `AWS.Scheduler.GetSchedule(${group?.LogicalId ?? "default"})`,
      )(function* (request: GetScheduleRequest) {
        const groupName = GroupName ? yield* GroupName : undefined;
        return yield* getSchedule({
          ...request,
          GroupName: groupName,
        });
      });
    });
  }),
);
