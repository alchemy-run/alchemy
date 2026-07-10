import * as scheduler from "@distilled.cloud/aws/scheduler";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Binding from "../../Binding.ts";
import * as Output from "../../Output.ts";
import { AWSEnvironment } from "../Environment.ts";
import { isBindingHost } from "../Lambda/Function.ts";
import {
  DeleteSchedule,
  type DeleteScheduleRequest,
} from "./DeleteSchedule.ts";
import type { ScheduleGroup } from "./ScheduleGroup.ts";

export const DeleteScheduleHttp = Layer.effect(
  DeleteSchedule,
  Effect.gen(function* () {
    const deleteSchedule = yield* scheduler.deleteSchedule;

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

          yield* host.bind`Allow(${host}, AWS.Scheduler.DeleteSchedule(${group ?? "default"}))`(
            {
              policyStatements: [
                {
                  Effect: "Allow",
                  Action: ["scheduler:DeleteSchedule"],
                  Resource: [scheduleArnPattern],
                },
              ],
            },
          );
        }
      }
      return Effect.fn(
        `AWS.Scheduler.DeleteSchedule(${group?.LogicalId ?? "default"})`,
      )(function* (request: DeleteScheduleRequest) {
        const groupName = GroupName ? yield* GroupName : undefined;
        return yield* deleteSchedule({
          ...request,
          GroupName: groupName,
        });
      });
    });
  }),
);
