import { Region } from "@distilled.cloud/aws/Region";
import * as cloudwatch from "@distilled.cloud/aws/cloudwatch";
import * as Effect from "effect/Effect";
import { Resource } from "../../Resource.ts";
import { Account, type AccountID } from "../Account.ts";
import type { RegionID } from "../Region.ts";
import {
  createName,
  ensureOwnedByAlchemy,
  readResourceTags,
  retryConcurrent,
  updateResourceTags,
} from "./common.ts";

export type AlarmMuteRuleName = string;
export type AlarmMuteRuleArn =
  `arn:aws:cloudwatch:${RegionID}:${AccountID}:alarm-mute-rule:${string}`;

export interface AlarmMuteRuleProps extends Omit<
  cloudwatch.PutAlarmMuteRuleInput,
  "Name" | "Tags"
> {
  /**
   * Name of the mute rule. If omitted, a unique name is generated.
   */
  name?: AlarmMuteRuleName;
  /**
   * Optional tags to apply to the mute rule.
   */
  tags?: Record<string, string>;
}

export interface AlarmMuteRule extends Resource<
  "AWS.CloudWatch.AlarmMuteRule",
  AlarmMuteRuleProps,
  {
    alarmMuteRuleName: AlarmMuteRuleName;
    alarmMuteRuleArn: AlarmMuteRuleArn;
    status: string | undefined;
    muteType: string | undefined;
    alarmMuteRule: cloudwatch.GetAlarmMuteRuleOutput;
    tags: Record<string, string>;
  }
> {}

/**
 * A CloudWatch alarm mute rule.
 *
 * @section Creating Mute Rules
 * @example Scheduled Mute
 * ```typescript
 * const rule = yield* AlarmMuteRule("NightlyMute", {
 *   Rule: {
 *     Schedule: {
 *       Expression: "cron(0 2 * * ? *)",
 *       Duration: "PT1H",
 *     },
 *   },
 * });
 * ```
 */
export const AlarmMuteRule = Resource<AlarmMuteRule>(
  "AWS.CloudWatch.AlarmMuteRule",
);

export const AlarmMuteRuleProvider = () =>
  AlarmMuteRule.provider.effect(
    Effect.gen(function* () {
      const region = yield* Region;
      const accountId = yield* Account;

      const createMuteRuleName = (id: string, props: { name?: string } = {}) =>
        createName(id, props.name, 255);

      const alarmMuteRuleArn = (name: string) =>
        `arn:aws:cloudwatch:${region}:${accountId}:alarm-mute-rule:${name}` as AlarmMuteRuleArn;

      const readAlarmMuteRule = Effect.fn(function* (name: string) {
        const output = yield* cloudwatch
          .getAlarmMuteRule({
            AlarmMuteRuleName: name,
          })
          .pipe(
            Effect.catchTag("ResourceNotFoundException", () =>
              Effect.succeed(undefined),
            ),
          );

        if (!output?.Name || !output.AlarmMuteRuleArn) {
          return undefined;
        }

        const tags = yield* readResourceTags(output.AlarmMuteRuleArn).pipe(
          Effect.catchTag("ResourceNotFoundException", () =>
            Effect.succeed({}),
          ),
        );

        return {
          alarmMuteRuleName: output.Name,
          alarmMuteRuleArn: output.AlarmMuteRuleArn as AlarmMuteRuleArn,
          status: output.Status,
          muteType: output.MuteType,
          alarmMuteRule: output,
          tags,
        };
      });

      return {
        stables: ["alarmMuteRuleName", "alarmMuteRuleArn"],
        diff: Effect.fn(function* ({ id, olds = {}, news = {} }) {
          const oldName = yield* createMuteRuleName(id, olds);
          const newName = yield* createMuteRuleName(id, news);

          if (oldName !== newName) {
            return { action: "replace" } as const;
          }
        }),
        read: Effect.fn(function* ({ id, olds, output }) {
          const name =
            output?.alarmMuteRuleName ??
            (yield* createMuteRuleName(id, olds ?? {}));
          return yield* readAlarmMuteRule(name);
        }),
        create: Effect.fn(function* ({ id, news, session }) {
          const name = yield* createMuteRuleName(id, news);
          const existing = yield* readAlarmMuteRule(name);

          if (existing) {
            yield* ensureOwnedByAlchemy(
              id,
              name,
              existing.tags,
              "alarm mute rule",
            );
          }

          yield* retryConcurrent(
            cloudwatch.putAlarmMuteRule({
              ...news,
              Name: name,
            }),
          );

          const tags = yield* updateResourceTags({
            id,
            resourceArn: alarmMuteRuleArn(name),
            olds: existing?.tags,
            news: news.tags,
          });

          yield* session.note(alarmMuteRuleArn(name));

          const state = yield* readAlarmMuteRule(name);
          if (!state) {
            return yield* Effect.fail(
              new Error(`failed to read created alarm mute rule '${name}'`),
            );
          }

          return {
            ...state,
            tags,
          };
        }),
        update: Effect.fn(function* ({ id, news, olds, output, session }) {
          yield* retryConcurrent(
            cloudwatch.putAlarmMuteRule({
              ...news,
              Name: output.alarmMuteRuleName,
            }),
          );

          const tags = yield* updateResourceTags({
            id,
            resourceArn: output.alarmMuteRuleArn,
            olds: olds.tags,
            news: news.tags,
          });

          yield* session.note(output.alarmMuteRuleArn);

          const state = yield* readAlarmMuteRule(output.alarmMuteRuleName);
          if (!state) {
            return yield* Effect.fail(
              new Error(
                `failed to read updated alarm mute rule '${output.alarmMuteRuleName}'`,
              ),
            );
          }

          return {
            ...state,
            tags,
          };
        }),
        delete: Effect.fn(function* ({ output }) {
          yield* retryConcurrent(
            cloudwatch.deleteAlarmMuteRule({
              AlarmMuteRuleName: output.alarmMuteRuleName,
            }),
          );
        }),
      };
    }),
  );
