import * as config from "@distilled.cloud/aws/config-service";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { createInternalTags, diffTags, hasAlchemyTags } from "../../Tags.ts";
import type { Providers } from "../Providers.ts";

/**
 * Identifies the rule's evaluation logic. Managed rules use `owner: "AWS"`
 * with a `sourceIdentifier` from the list of AWS Config managed rules.
 */
export interface ConfigRuleSource {
  /**
   * Who owns the rule logic. `AWS` for managed rules, `CUSTOM_LAMBDA` for a
   * custom Lambda rule, `CUSTOM_POLICY` for a Guard policy rule.
   */
  owner: "AWS" | "CUSTOM_LAMBDA" | "CUSTOM_POLICY";
  /**
   * For `AWS` managed rules, the managed-rule identifier (e.g.
   * `S3_BUCKET_PUBLIC_READ_PROHIBITED`). For `CUSTOM_LAMBDA`, the ARN of the
   * evaluating Lambda function.
   */
  sourceIdentifier?: string;
}

/**
 * Scopes the resources a rule evaluates.
 */
export interface ConfigRuleScope {
  /**
   * Resource types to evaluate, e.g. `AWS::S3::Bucket`.
   */
  complianceResourceTypes?: string[];
  /**
   * A single resource id to evaluate (requires exactly one entry in
   * `complianceResourceTypes`).
   */
  complianceResourceId?: string;
  /**
   * Tag key used to constrain evaluated resources.
   */
  tagKey?: string;
  /**
   * Tag value used to constrain evaluated resources.
   */
  tagValue?: string;
}

export interface ConfigRuleProps {
  /**
   * Name of the Config rule. Changing the name replaces the rule.
   * @default ${app}-${stage}-${id}
   */
  configRuleName?: string;
  /**
   * Human-readable description of the rule.
   */
  description?: string;
  /**
   * The rule's evaluation source.
   */
  source: ConfigRuleSource;
  /**
   * The resources the rule evaluates.
   */
  scope?: ConfigRuleScope;
  /**
   * Rule parameters as a JSON string or plain object.
   */
  inputParameters?: string | Record<string, unknown>;
  /**
   * How frequently AWS Config runs periodic evaluations.
   */
  maximumExecutionFrequency?:
    | "One_Hour"
    | "Three_Hours"
    | "Six_Hours"
    | "Twelve_Hours"
    | "TwentyFour_Hours";
  /**
   * Tags to apply to the rule. Merged with internal Alchemy tags.
   */
  tags?: Record<string, string>;
}

export interface ConfigRule extends Resource<
  "AWS.Config.ConfigRule",
  ConfigRuleProps,
  {
    configRuleName: string;
    configRuleArn: string;
    configRuleId: string;
    configRuleState: string;
  },
  never,
  Providers
> {}

/**
 * An AWS Config rule that evaluates whether your resources comply with a
 * desired configuration.
 *
 * Managed rules (`source.owner: "AWS"`) are the common case — supply a
 * `sourceIdentifier` such as `S3_BUCKET_PUBLIC_READ_PROHIBITED`. A configuration
 * recorder must exist in the region before a rule can be created.
 * @resource
 * @section Managed Rules
 * @example Prohibit public-read S3 buckets
 * ```typescript
 * import * as Config from "alchemy/AWS/Config";
 *
 * const rule = yield* Config.ConfigRule("NoPublicBuckets", {
 *   source: {
 *     owner: "AWS",
 *     sourceIdentifier: "S3_BUCKET_PUBLIC_READ_PROHIBITED",
 *   },
 * });
 * ```
 *
 * @example Scope a rule to a resource type
 * ```typescript
 * const rule = yield* Config.ConfigRule("EncryptedVolumes", {
 *   source: { owner: "AWS", sourceIdentifier: "ENCRYPTED_VOLUMES" },
 *   scope: { complianceResourceTypes: ["AWS::EC2::Volume"] },
 * });
 * ```
 */
export const ConfigRule = Resource<ConfigRule>("AWS.Config.ConfigRule");

export const ConfigRuleProvider = () =>
  Provider.effect(
    ConfigRule,
    Effect.gen(function* () {
      const createRuleName = Effect.fn(function* (
        id: string,
        props: { configRuleName?: string | undefined },
      ) {
        return (
          props.configRuleName ??
          (yield* createPhysicalName({ id, maxLength: 128 }))
        );
      });

      const observeRule = (name: string) =>
        config.describeConfigRules({ ConfigRuleNames: [name] }).pipe(
          Effect.map((r) => r.ConfigRules?.[0]),
          Effect.catchTag("NoSuchConfigRuleException", () =>
            Effect.succeed(undefined),
          ),
        );

      const fetchRuleTags = (arn: string) =>
        config.listTagsForResource({ ResourceArn: arn }).pipe(
          Effect.map(
            (r) =>
              Object.fromEntries(
                (r.Tags ?? []).flatMap((t) =>
                  t.Key ? [[t.Key, t.Value ?? ""] as const] : [],
                ),
              ) as Record<string, string>,
          ),
          Effect.catch(() => Effect.succeed({} as Record<string, string>)),
        );

      const toInputParameters = (
        params: string | Record<string, unknown> | undefined,
      ): string | undefined =>
        params === undefined
          ? undefined
          : typeof params === "string"
            ? params
            : JSON.stringify(params);

      return ConfigRule.Provider.of({
        stables: ["configRuleName", "configRuleArn", "configRuleId"],
        // Enumerate every Config rule in the ambient account/region.
        list: () =>
          config.describeConfigRules.items({}).pipe(
            Stream.runCollect,
            Effect.map((chunk) =>
              Array.from(chunk).flatMap((rule) =>
                rule.ConfigRuleName
                  ? [
                      {
                        configRuleName: rule.ConfigRuleName,
                        configRuleArn: rule.ConfigRuleArn ?? "",
                        configRuleId: rule.ConfigRuleId ?? "",
                        configRuleState: rule.ConfigRuleState ?? "ACTIVE",
                      },
                    ]
                  : [],
              ),
            ),
            Effect.catchTag("NoSuchConfigRuleException", () =>
              Effect.succeed([]),
            ),
          ),
        read: Effect.fn(function* ({ id, olds, output }) {
          const name =
            output?.configRuleName ?? (yield* createRuleName(id, olds ?? {}));
          const rule = yield* observeRule(name);
          if (!rule) return undefined;
          const attrs = {
            configRuleName: name,
            configRuleArn: rule.ConfigRuleArn ?? "",
            configRuleId: rule.ConfigRuleId ?? "",
            configRuleState: rule.ConfigRuleState ?? "ACTIVE",
          };
          const tags = rule.ConfigRuleArn
            ? yield* fetchRuleTags(rule.ConfigRuleArn)
            : {};
          return (yield* hasAlchemyTags(id, tags)) ? attrs : Unowned(attrs);
        }),
        diff: Effect.fn(function* ({ id, news = {}, olds = {} }) {
          if (!isResolved(news)) return undefined;
          const oldName = yield* createRuleName(id, olds);
          const newName = yield* createRuleName(id, news);
          if (oldName !== newName) {
            return { action: "replace" } as const;
          }
        }),
        reconcile: Effect.fn(function* ({ id, news = {}, output, session }) {
          const name =
            output?.configRuleName ?? (yield* createRuleName(id, news));
          const internalTags = yield* createInternalTags(id);

          // putConfigRule is an idempotent upsert. Tags on the request only
          // apply on first create, so tags are reconciled separately below. A
          // Config rule requires a configuration recorder; when the recorder is
          // provisioned in the same deploy it may not be visible yet, surfacing
          // as NoAvailableConfigurationRecorderException — retry on a bounded
          // schedule so ordering within a deploy converges.
          yield* config
            .putConfigRule({
              ConfigRule: {
                ConfigRuleName: name,
                Description: news.description,
                Source: {
                  Owner: news.source.owner,
                  SourceIdentifier: news.source.sourceIdentifier,
                },
                Scope: news.scope
                  ? {
                      ComplianceResourceTypes:
                        news.scope.complianceResourceTypes,
                      ComplianceResourceId: news.scope.complianceResourceId,
                      TagKey: news.scope.tagKey,
                      TagValue: news.scope.tagValue,
                    }
                  : undefined,
                InputParameters: toInputParameters(news.inputParameters),
                MaximumExecutionFrequency: news.maximumExecutionFrequency,
              },
              Tags: Object.entries({ ...news.tags, ...internalTags }).map(
                ([Key, Value]) => ({ Key, Value }),
              ),
            })
            .pipe(
              Effect.retry({
                while: (e) =>
                  e._tag === "NoAvailableConfigurationRecorderException",
                schedule: Schedule.fixed(2000).pipe(
                  Schedule.both(Schedule.recurs(15)),
                ),
              }),
            );

          // Re-read to capture the AWS-generated ARN, id, and state.
          const rule = yield* observeRule(name);
          const configRuleArn = rule?.ConfigRuleArn ?? "";

          // Reconcile tags against observed cloud tags (PutConfigRule ignores
          // tag changes on update).
          if (configRuleArn) {
            const currentTags = yield* fetchRuleTags(configRuleArn);
            const { upsert, removed } = diffTags(currentTags, {
              ...news.tags,
              ...internalTags,
            });
            if (upsert.length > 0) {
              yield* config.tagResource({
                ResourceArn: configRuleArn,
                Tags: upsert.map((t) => ({ Key: t.Key, Value: t.Value })),
              });
            }
            if (removed.length > 0) {
              yield* config.untagResource({
                ResourceArn: configRuleArn,
                TagKeys: removed,
              });
            }
          }

          yield* session.note(name);
          return {
            configRuleName: name,
            configRuleArn,
            configRuleId: rule?.ConfigRuleId ?? "",
            configRuleState: rule?.ConfigRuleState ?? "ACTIVE",
          };
        }),
        delete: Effect.fn(function* ({ output }) {
          // A rule mid-delete returns ResourceInUseException; retry briefly.
          yield* config
            .deleteConfigRule({ ConfigRuleName: output.configRuleName })
            .pipe(
              Effect.retry({
                while: (e) => e._tag === "ResourceInUseException",
                schedule: Schedule.fixed(3000).pipe(
                  Schedule.both(Schedule.recurs(10)),
                ),
              }),
              Effect.catchTag("NoSuchConfigRuleException", () => Effect.void),
            );
        }),
      });
    }),
  );
