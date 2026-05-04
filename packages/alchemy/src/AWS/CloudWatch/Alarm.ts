import { Region } from "@distilled.cloud/aws/Region";
import * as cloudwatch from "@distilled.cloud/aws/cloudwatch";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { hasAlchemyTags } from "../../Tags.ts";
import type { Providers } from "../Providers.ts";
import { AWSEnvironment, type AccountID } from "../Environment.ts";
import type { RegionID } from "../Region.ts";
import {
  createName,
  readResourceTags,
  retryConcurrent,
  updateResourceTags,
} from "./common.ts";

export type AlarmName = string;
export type AlarmArn =
  `arn:aws:cloudwatch:${RegionID}:${AccountID}:alarm:${string}`;
export type AlarmStateValue = cloudwatch.StateValue;

export interface AlarmProps extends Omit<
  cloudwatch.PutMetricAlarmInput,
  "AlarmName" | "Tags"
> {
  /**
   * Name of the alarm. If omitted, a unique name is generated.
   */
  name?: AlarmName;
  /**
   * Optional tags to apply to the alarm.
   */
  tags?: Record<string, string>;
}

export interface Alarm extends Resource<
  "AWS.CloudWatch.Alarm",
  AlarmProps,
  {
    alarmName: AlarmName;
    alarmArn: AlarmArn;
    stateValue: AlarmStateValue | undefined;
    stateReason: string | undefined;
    metricAlarm: cloudwatch.MetricAlarm;
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * A CloudWatch metric alarm.
 *
 * @section Creating Alarms
 * @example Threshold Alarm
 * ```typescript
 * const alarm = yield* Alarm("HighErrors", {
 *   MetricName: "Errors",
 *   Namespace: "AWS/Lambda",
 *   Statistic: "Sum",
 *   Period: 60,
 *   EvaluationPeriods: 1,
 *   Threshold: 1,
 *   ComparisonOperator: "GreaterThanOrEqualToThreshold",
 * });
 * ```
 */
export const Alarm = Resource<Alarm>("AWS.CloudWatch.Alarm");

export const AlarmProvider = () =>
  Provider.effect(
    Alarm,
    Effect.gen(function* () {
      const region = yield* Region;
      const { accountId } = yield* AWSEnvironment;

      const createAlarmName = (id: string, props: { name?: string } = {}) =>
        createName(id, props.name, 255);

      const alarmArn = (alarmName: string) =>
        `arn:aws:cloudwatch:${region}:${accountId}:alarm:${alarmName}` as AlarmArn;

      const readAlarm = Effect.fn(function* (alarmName: string) {
        const described = yield* cloudwatch.describeAlarms({
          AlarmNames: [alarmName],
          AlarmTypes: ["MetricAlarm"],
        });
        const metricAlarm = described.MetricAlarms?.find(
          (candidate) => candidate.AlarmName === alarmName,
        );

        if (!metricAlarm?.AlarmName || !metricAlarm.AlarmArn) {
          return undefined;
        }

        const tags = yield* readResourceTags(metricAlarm.AlarmArn).pipe(
          Effect.catchTag("ResourceNotFoundException", () =>
            Effect.succeed({}),
          ),
        );

        return {
          alarmName: metricAlarm.AlarmName,
          alarmArn: metricAlarm.AlarmArn as AlarmArn,
          stateValue: metricAlarm.StateValue,
          stateReason: metricAlarm.StateReason,
          metricAlarm,
          tags,
        };
      });

      return {
        stables: ["alarmName", "alarmArn"],
        diff: Effect.fn(function* ({ id, olds = {}, news = {} }) {
          if (!isResolved(news)) return undefined;
          const oldName = yield* createAlarmName(id, olds);
          const newName = yield* createAlarmName(id, news);

          if (oldName !== newName) {
            return { action: "replace" } as const;
          }
        }),
        read: Effect.fn(function* ({ id, olds, output }) {
          const name =
            output?.alarmName ?? (yield* createAlarmName(id, olds ?? {}));
          const state = yield* readAlarm(name);
          if (!state) return undefined;
          return (yield* hasAlchemyTags(id, state.tags))
            ? state
            : Unowned(state);
        }),
        create: Effect.fn(function* ({ id, news, session }) {
          const name = yield* createAlarmName(id, news);
          // Engine has cleared us via `read` (foreign-tagged alarms are
          // surfaced as `Unowned`). `putMetricAlarm` is itself idempotent.
          const existing = yield* readAlarm(name);

          yield* retryConcurrent(
            cloudwatch.putMetricAlarm({
              ...news,
              AlarmName: name,
            }),
          );

          const tags = yield* updateResourceTags({
            id,
            resourceArn: alarmArn(name),
            olds: existing?.tags,
            news: news.tags,
          });

          yield* session.note(alarmArn(name));

          const state = yield* readAlarm(name);
          if (!state) {
            return yield* Effect.fail(
              new Error(`failed to read created alarm '${name}'`),
            );
          }

          return {
            ...state,
            tags,
          };
        }),
        update: Effect.fn(function* ({ id, news, olds, output, session }) {
          yield* retryConcurrent(
            cloudwatch.putMetricAlarm({
              ...news,
              AlarmName: output.alarmName,
            }),
          );

          const tags = yield* updateResourceTags({
            id,
            resourceArn: output.alarmArn,
            olds: olds.tags,
            news: news.tags,
          });

          yield* session.note(output.alarmArn);

          const state = yield* readAlarm(output.alarmName);
          if (!state) {
            return yield* Effect.fail(
              new Error(`failed to read updated alarm '${output.alarmName}'`),
            );
          }

          return {
            ...state,
            tags,
          };
        }),
        delete: Effect.fn(function* ({ output }) {
          yield* retryConcurrent(
            cloudwatch.deleteAlarms({
              AlarmNames: [output.alarmName],
            }),
          );
        }),
      };
    }),
  );
