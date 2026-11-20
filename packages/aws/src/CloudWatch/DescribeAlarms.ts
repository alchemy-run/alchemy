import * as cloudwatch from "@distilled.cloud/aws/cloudwatch";
import * as Binding from "alchemy/Binding";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as AWSBindings from "../AWSBindings.ts";
import { type AlarmResource, sortAlarmResources } from "./binding-common.ts";

export interface DescribeAlarmsRequest extends Omit<cloudwatch.DescribeAlarmsInput, "AlarmNames"> {}

type AlarmResources = [AlarmResource, ...AlarmResource[]];

/**
 * Runtime binding for `cloudwatch:DescribeAlarms` — read the current state
 * and configuration of the bound alarms. Bind it to one or more
 * {@link Alarm} / {@link CompositeAlarm} resources; the alarm names are
 * injected automatically.
 *
 * Provide `CloudWatch.DescribeAlarmsHttp` on the hosting Lambda Function to
 * satisfy the requirement.
 * ### Reading Alarm State
 * **Example:** Read the State of a Bound Alarm
 * ```typescript
 * const alarm = yield* CloudWatch.Alarm("HighErrors", {
 *   MetricName: "Errors",
 *   Namespace: "AWS/Lambda",
 *   Statistic: "Sum",
 *   Period: 60,
 *   EvaluationPeriods: 1,
 *   Threshold: 1,
 *   ComparisonOperator: "GreaterThanOrEqualToThreshold",
 * });
 *
 * // init — grants cloudwatch:DescribeAlarms on the alarm
 * const describeAlarms = yield* AWS.CloudWatch.DescribeAlarms(alarm);
 *
 * // runtime
 * const result = yield* describeAlarms();
 * const state = result.MetricAlarms?.[0]?.StateValue; // "OK" | "ALARM" | ...
 * ```
 *
 * @binding
 */
export interface DescribeAlarms extends Binding.Service<
  DescribeAlarms,
  "AWS.CloudWatch.DescribeAlarms",
  (
    ...alarms: AlarmResources
  ) => Effect.Effect<
    (request?: DescribeAlarmsRequest) => Effect.Effect<cloudwatch.DescribeAlarmsOutput, any>
  >
> {}

export const DescribeAlarms = Binding.Service<DescribeAlarms>("AWS.CloudWatch.DescribeAlarms");

export const DescribeAlarmsHttp = Layer.effect(
  DescribeAlarms,
  Effect.gen(function* () {
    const bind = yield* AWSBindings.Bind;
    const describeAlarms = yield* AWSBindings.withCredentials(cloudwatch.describeAlarms);

    return Effect.fn(function* (...alarms: AlarmResources) {
      const sorted = sortAlarmResources(alarms);
      const AlarmNames = yield* Effect.forEach(sorted, (alarm) => alarm.alarmName.asEffect());
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        yield* bind`AWS.CloudWatch.DescribeAlarms(${sorted})`({
          policyStatements: [
            {
              Effect: "Allow",
              Action: ["cloudwatch:DescribeAlarms"],
              // AWS requires "*" here to return composite alarms.
              Resource: ["*"],
            },
          ],
        });
      }

      return Effect.fn(
        `AWS.CloudWatch.DescribeAlarms(${sorted.map((alarm) => alarm.LogicalId).join(", ")})`,
      )(function* (request: DescribeAlarmsRequest = {}) {
        return yield* describeAlarms({
          ...request,
          AlarmTypes: getAlarmTypes(sorted),
          AlarmNames: yield* Effect.forEach(AlarmNames, (alarmName) => alarmName),
        });
      });
    });
  }),
);

const getAlarmTypes = (alarms: AlarmResources) =>
  [
    ...new Set(
      alarms.map((alarm) =>
        alarm.Type === "AWS.CloudWatch.CompositeAlarm" ? "CompositeAlarm" : "MetricAlarm",
      ),
    ),
  ] as cloudwatch.AlarmType[];
