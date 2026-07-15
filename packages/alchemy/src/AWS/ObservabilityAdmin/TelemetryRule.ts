import * as obs from "@distilled.cloud/aws/observabilityadmin";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { createInternalTags, diffTags, hasAlchemyTags } from "../../Tags.ts";
import { toWireDays } from "../../Util/Duration.ts";
import type { Providers } from "../Providers.ts";

/**
 * Where a telemetry rule delivers the telemetry it enables. Mirrors the wire
 * `TelemetryDestinationConfiguration`, with the retention period expressed as
 * a `Duration.Input` instead of the wire's `RetentionInDays`.
 */
export interface TelemetryRuleDestination extends Omit<
  obs.TelemetryDestinationConfiguration,
  "RetentionInDays"
> {
  /**
   * How long CloudWatch Logs retains the telemetry delivered by this rule.
   * Accepts any `Duration.Input` (e.g. `"30 days"`, `Duration.days(90)`);
   * converted to whole days on the wire (`RetentionInDays`).
   */
  Retention?: Duration.Input;
}

export interface TelemetryRuleProps {
  /**
   * Name of the telemetry rule. If omitted, a deterministic physical name is
   * generated. Changing the name replaces the rule.
   */
  ruleName?: string;
  /**
   * The type of telemetry the rule enables — `"Logs"`, `"Metrics"`, or
   * `"Traces"`.
   */
  telemetryType: obs.TelemetryType;
  /**
   * The AWS resource type the rule applies to, e.g. `"AWS::EC2::VPC"`.
   */
  resourceType?: obs.ResourceType;
  /**
   * The telemetry sources the rule enables, e.g. `["VPC_FLOW_LOGS"]`.
   */
  telemetrySourceTypes?: obs.TelemetrySourceType[];
  /**
   * Where the enabled telemetry is delivered (destination type, pattern,
   * retention, and per-source parameters such as VPC flow-log format).
   */
  destinationConfiguration?: TelemetryRuleDestination;
  /**
   * Organization-level scope selector (organization rules only).
   */
  scope?: string;
  /**
   * Criteria selecting which resources the rule configures, e.g.
   * `"ResourceTags['team'] = 'my-team'"`. Without selection criteria the
   * rule applies to every resource of `resourceType` in the account.
   */
  selectionCriteria?: string;
  /**
   * Whether the rule's telemetry parameters may be updated after creation.
   */
  allowFieldUpdates?: boolean;
  /**
   * Regions the rule applies to. Mutually exclusive with `allRegions`.
   */
  regions?: string[];
  /**
   * Apply the rule in all regions. Mutually exclusive with `regions`.
   */
  allRegions?: boolean;
  /**
   * User-defined tags for the rule.
   */
  tags?: Record<string, string>;
}

export interface TelemetryRule extends Resource<
  "AWS.ObservabilityAdmin.TelemetryRule",
  TelemetryRuleProps,
  {
    /** The name of the telemetry rule. */
    ruleName: string;
    /** The ARN of the telemetry rule. */
    ruleArn: string;
    /** The telemetry type the rule enables. */
    telemetryType: string | undefined;
    /** The resource type the rule applies to. */
    resourceType: string | undefined;
    /** The tags applied to the rule. */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * A CloudWatch **telemetry rule** (Observability Admin) — automatically
 * enables telemetry (such as VPC flow logs) for AWS resources in your
 * account that match the rule's criteria.
 *
 * The account must be onboarded to CloudWatch telemetry config (see
 * `ObservabilityAdmin.TelemetryConfig`) before rules can be created.
 *
 * @resource
 * @section Creating a Telemetry Rule
 * @example Enable VPC flow logs for tagged VPCs
 * ```typescript
 * import * as ObservabilityAdmin from "alchemy/AWS/ObservabilityAdmin";
 *
 * // Onboard the account to telemetry config first.
 * const telemetry = yield* ObservabilityAdmin.TelemetryConfig("Telemetry");
 *
 * const rule = yield* ObservabilityAdmin.TelemetryRule("FlowLogs", {
 *   resourceType: "AWS::EC2::VPC",
 *   telemetryType: "Logs",
 *   telemetrySourceTypes: ["VPC_FLOW_LOGS"],
 *   selectionCriteria: "ResourceTags['team'] = 'networking'",
 *   destinationConfiguration: {
 *     DestinationType: "cloud-watch-logs",
 *     Retention: "30 days",
 *   },
 * });
 * ```
 *
 * @example Custom flow-log parameters
 * ```typescript
 * const rule = yield* ObservabilityAdmin.TelemetryRule("FlowLogs", {
 *   resourceType: "AWS::EC2::VPC",
 *   telemetryType: "Logs",
 *   telemetrySourceTypes: ["VPC_FLOW_LOGS"],
 *   selectionCriteria: "ResourceTags['team'] = 'networking'",
 *   destinationConfiguration: {
 *     DestinationType: "cloud-watch-logs",
 *     Retention: "90 days",
 *     VPCFlowLogParameters: {
 *       TrafficType: "REJECT",
 *       MaxAggregationInterval: 600,
 *     },
 *   },
 * });
 * ```
 */
export const TelemetryRule = Resource<TelemetryRule>(
  "AWS.ObservabilityAdmin.TelemetryRule",
);

/** Normalize the wire tag map (values may be undefined) to a plain record. */
const toTagRecord = (
  tags: { [key: string]: string | undefined } | undefined,
): Record<string, string> =>
  Object.fromEntries(
    Object.entries(tags ?? {}).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );

const sameJson = (a: unknown, b: unknown): boolean =>
  JSON.stringify(a) === JSON.stringify(b);

/**
 * True when any field the desired rule declares differs from the observed
 * rule. Fields the desired rule leaves unset are don't-cares (AWS echoes
 * service defaults for them).
 */
const ruleNeedsUpdate = (
  desired: obs.TelemetryRule,
  observed: obs.TelemetryRule | undefined,
): boolean =>
  observed === undefined ||
  Object.entries(desired).some(
    ([key, value]) =>
      !sameJson(value, (observed as Record<string, unknown>)[key]),
  );

/** Project props to the wire `TelemetryRule` struct (dropping undefineds). */
const toWireRule = (props: TelemetryRuleProps): obs.TelemetryRule =>
  JSON.parse(
    JSON.stringify({
      ResourceType: props.resourceType,
      TelemetryType: props.telemetryType,
      TelemetrySourceTypes: props.telemetrySourceTypes,
      DestinationConfiguration:
        props.destinationConfiguration === undefined
          ? undefined
          : (() => {
              const { Retention, ...rest } = props.destinationConfiguration;
              return {
                ...rest,
                RetentionInDays: toWireDays(Retention),
              };
            })(),
      Scope: props.scope,
      SelectionCriteria: props.selectionCriteria,
      AllowFieldUpdates: props.allowFieldUpdates,
      Regions: props.regions,
      AllRegions: props.allRegions,
    }),
  );

export const TelemetryRuleProvider = () =>
  Provider.effect(
    TelemetryRule,
    Effect.gen(function* () {
      const createName = Effect.fn(function* (
        id: string,
        props: TelemetryRuleProps,
      ) {
        return props.ruleName ?? (yield* createPhysicalName({ id }));
      });

      const readRule = Effect.fn(function* (identifier: string) {
        return yield* obs
          .getTelemetryRule({ RuleIdentifier: identifier })
          .pipe(
            Effect.catchTag("ResourceNotFoundException", () =>
              Effect.succeed(undefined),
            ),
          );
      });

      const readTags = Effect.fn(function* (ruleArn: string) {
        return yield* obs.listTagsForResource({ ResourceARN: ruleArn }).pipe(
          Effect.map((r) => toTagRecord(r.Tags)),
          Effect.catchTag("ResourceNotFoundException", () =>
            Effect.succeed({} as Record<string, string>),
          ),
        );
      });

      const toAttrs = (
        rule: obs.GetTelemetryRuleOutput,
        tags: Record<string, string>,
      ) => ({
        ruleName: rule.RuleName ?? "",
        ruleArn: rule.RuleArn ?? "",
        telemetryType: rule.TelemetryRule?.TelemetryType,
        resourceType: rule.TelemetryRule?.ResourceType,
        tags,
      });

      const readAttrs = Effect.fn(function* (identifier: string) {
        const rule = yield* readRule(identifier);
        if (rule === undefined || rule.RuleArn === undefined) return undefined;
        const tags = yield* readTags(rule.RuleArn);
        return toAttrs(rule, tags);
      });

      return TelemetryRule.Provider.of({
        stables: ["ruleName", "ruleArn"],

        list: () =>
          obs.listTelemetryRules.items({}).pipe(
            Stream.runCollect,
            Effect.flatMap((summaries) =>
              Effect.forEach(
                Array.from(summaries).flatMap((s) =>
                  s.RuleName === undefined ? [] : [s.RuleName],
                ),
                (name) => readAttrs(name),
                { concurrency: 4 },
              ),
            ),
            Effect.map((attrs) =>
              attrs.flatMap((a) => (a === undefined ? [] : [a])),
            ),
          ),

        read: Effect.fn(function* ({ id, olds, output }) {
          const name = output?.ruleName ?? (yield* createName(id, olds ?? {}));
          const attrs = yield* readAttrs(name);
          if (attrs === undefined) return undefined;
          return (yield* hasAlchemyTags(id, attrs.tags))
            ? attrs
            : Unowned(attrs);
        }),

        diff: Effect.fn(function* ({ id, news, olds }) {
          if (!isResolved(news)) return undefined;
          // The name is the only immutable property; the rule configuration
          // is updatable in place via UpdateTelemetryRule.
          if ((yield* createName(id, olds)) !== (yield* createName(id, news))) {
            return { action: "replace" } as const;
          }
          return undefined;
        }),

        reconcile: Effect.fn(function* ({ id, news, output, session }) {
          const props = news!;
          const name = output?.ruleName ?? (yield* createName(id, props));
          const internalTags = yield* createInternalTags(id);
          const desiredTags = { ...props.tags, ...internalTags };
          const desiredRule = toWireRule(props);

          // 1. Observe — cloud state is authoritative.
          let observed = yield* readRule(name);

          // 2. Ensure — create if missing; a ConflictException means a peer
          //    created the same-named rule concurrently, so re-observe.
          if (observed === undefined) {
            yield* obs
              .createTelemetryRule({
                RuleName: name,
                Rule: desiredRule,
                Tags: desiredTags,
              })
              .pipe(Effect.catchTag("ConflictException", () => Effect.void));
            // The read-after-create is eventually consistent; wait (bounded)
            // for the rule to materialize.
            observed = yield* readRule(name).pipe(
              Effect.flatMap((rule) =>
                rule === undefined
                  ? Effect.fail(
                      new Error(`telemetry rule '${name}' not yet visible`),
                    )
                  : Effect.succeed(rule),
              ),
              Effect.retry({
                schedule: Schedule.max([
                  Schedule.fixed("2 seconds"),
                  Schedule.recurs(8),
                ]),
              }),
            );
          } else if (ruleNeedsUpdate(desiredRule, observed.TelemetryRule)) {
            // 3. Sync — UpdateTelemetryRule replaces the whole rule config;
            //    apply only on an actual delta against OBSERVED state.
            yield* obs.updateTelemetryRule({
              RuleIdentifier: name,
              Rule: desiredRule,
            });
            observed = (yield* readRule(name)) ?? observed;
          }

          // 3b. Sync tags — diff against OBSERVED cloud tags.
          const ruleArn = observed.RuleArn!;
          const observedTags = yield* readTags(ruleArn);
          const { removed, upsert } = diffTags(observedTags, desiredTags);
          if (upsert.length > 0) {
            yield* obs.tagResource({
              ResourceARN: ruleArn,
              Tags: Object.fromEntries(upsert.map((t) => [t.Key, t.Value])),
            });
          }
          if (removed.length > 0) {
            yield* obs.untagResource({
              ResourceARN: ruleArn,
              TagKeys: removed,
            });
          }

          yield* session.note(name);
          const tags = yield* readTags(ruleArn);
          return toAttrs(observed, tags);
        }),

        delete: Effect.fn(function* ({ output }) {
          yield* obs
            .deleteTelemetryRule({ RuleIdentifier: output.ruleName })
            .pipe(
              Effect.catchTag("ResourceNotFoundException", () => Effect.void),
            );
        }),
      });
    }),
  );
