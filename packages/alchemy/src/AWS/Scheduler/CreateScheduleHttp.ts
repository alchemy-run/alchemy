import * as scheduler from "@distilled.cloud/aws/scheduler";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Binding from "../../Binding.ts";
import * as Output from "../../Output.ts";
import { AWSEnvironment } from "../Environment.ts";
import type { Role } from "../IAM/Role.ts";
import { isFunction } from "../Lambda/Function.ts";
import {
  CreateSchedule,
  type CreateScheduleRequest,
} from "./CreateSchedule.ts";
import type { ScheduleGroup } from "./ScheduleGroup.ts";

export const CreateScheduleHttp = Layer.effect(
  CreateSchedule,
  Effect.gen(function* () {
    const createSchedule = yield* scheduler.createSchedule;

    return Effect.fn(function* <R extends Role>(
      executionRole: R,
      group?: ScheduleGroup,
    ) {
      const RoleArn = yield* executionRole.roleArn;
      const GroupName = group ? yield* group.scheduleGroupName : undefined;
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        if (isFunction(host)) {
          const { accountId, region } =
            yield* AWSEnvironment.current as unknown as Effect.Effect<{
              accountId: string;
              region: string;
            }>;
          // Dynamic schedules are named at runtime, so the resource pattern is
          // group-scoped rather than an exact ARN: the group (or the default
          // group) is the least-privilege boundary for runtime-minted
          // schedules. Pass unresolved Outputs — binding data is resolved by
          // the engine before the host reconciles.
          const scheduleArnPattern = group
            ? Output.interpolate`arn:aws:scheduler:${region}:${accountId}:schedule/${group.scheduleGroupName}/*`
            : (`arn:aws:scheduler:${region}:${accountId}:schedule/default/*` as const);

          yield* host.bind`Allow(${host}, AWS.Scheduler.CreateSchedule(${executionRole}, ${group ?? "default"}))`(
            {
              policyStatements: [
                {
                  Effect: "Allow",
                  Action: ["scheduler:CreateSchedule"],
                  Resource: [scheduleArnPattern],
                },
                // CRITICAL: without iam:PassRole on the execution role,
                // CreateSchedule fails only at runtime with an AccessDenied.
                {
                  Effect: "Allow",
                  Action: ["iam:PassRole"],
                  Resource: [Output.interpolate`${executionRole.roleArn}`],
                  Condition: {
                    StringEquals: {
                      "iam:PassedToService": "scheduler.amazonaws.com",
                    },
                  },
                },
              ],
            },
          );
        }
      }
      return Effect.fn(
        `AWS.Scheduler.CreateSchedule(${executionRole.LogicalId})`,
      )(function* (request: CreateScheduleRequest) {
        const roleArn = yield* RoleArn;
        const groupName = GroupName ? yield* GroupName : undefined;
        return yield* createSchedule({
          ...request,
          GroupName: groupName,
          FlexibleTimeWindow: request.FlexibleTimeWindow ?? { Mode: "OFF" },
          Target: {
            ...request.Target,
            RoleArn: request.Target.RoleArn ?? roleArn,
          },
        });
      });
    });
  }),
);
