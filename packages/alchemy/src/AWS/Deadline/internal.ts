import * as logs from "@distilled.cloud/aws/cloudwatch-logs";
import * as deadline from "@distilled.cloud/aws/deadline";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";
import * as EffectStream from "effect/Stream";
import { diffTags } from "../../Tags.ts";
import { AWSEnvironment } from "../Environment.ts";

/**
 * Unwrap distilled `SensitiveString` values (`string | Redacted<string>`)
 * to a plain string for drift comparison.
 */
export const asPlain = (
  value: string | Redacted.Redacted<string> | undefined,
): string | undefined =>
  value === undefined
    ? undefined
    : Redacted.isRedacted(value)
      ? Redacted.value(value)
      : value;

/**
 * Build a Deadline Cloud ARN factory bound to the ambient account/region.
 * Paths look like `farm/{farmId}`, `farm/{farmId}/queue/{queueId}`,
 * `monitor/{monitorId}`.
 */
export const deadlineArnOf = Effect.gen(function* () {
  const { accountId, region } = yield* AWSEnvironment.current;
  return (path: string) => `arn:aws:deadline:${region}:${accountId}:${path}`;
});

/**
 * Read the observed tags of a Deadline resource. A missing resource (or a
 * resource type without tag support) reads as an empty tag set.
 */
export const fetchDeadlineTags = Effect.fn(function* (arn: string) {
  const response = yield* deadline
    .listTagsForResource({ resourceArn: arn })
    .pipe(
      Effect.catchTag("ResourceNotFoundException", () =>
        Effect.succeed(undefined),
      ),
    );
  return Object.fromEntries(
    Object.entries(response?.tags ?? {}).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );
});

/**
 * Converge a Deadline resource's tags to the desired set, diffing against
 * the OBSERVED cloud tags (never olds/output).
 */
export const syncDeadlineTags = Effect.fn(function* (
  arn: string,
  desired: Record<string, string>,
) {
  const observed = yield* fetchDeadlineTags(arn);
  const { removed, upsert } = diffTags(observed, desired);
  if (removed.length > 0) {
    yield* deadline.untagResource({ resourceArn: arn, tagKeys: removed });
  }
  if (upsert.length > 0) {
    yield* deadline.tagResource({
      resourceArn: arn,
      tags: Object.fromEntries(upsert.map(({ Key, Value }) => [Key, Value])),
    });
  }
});

/**
 * Deadline auto-creates CloudWatch log groups under
 * `/aws/deadline/{farmId}/{queueId}` (queue job/session logs) and
 * `/aws/deadline/{farmId}/{fleetId}/...` (fleet worker logs), and neither
 * `deleteQueue` nor `deleteFarm` removes them — without this reap every
 * deleted farm strands orphaned log groups. Idempotent: a group already
 * gone (or never created) is not an error.
 */
export const reapDeadlineLogGroups = Effect.fn(function* (prefix: string) {
  const groups = yield* logs.describeLogGroups
    .pages({ logGroupNamePrefix: prefix })
    .pipe(
      EffectStream.runCollect,
      Effect.map((chunk) =>
        Array.from(chunk)
          .flatMap((page) => page.logGroups ?? [])
          .map((group) => group.logGroupName)
          .filter((name): name is string => name != null),
      ),
    );
  yield* Effect.forEach(
    groups,
    (logGroupName) =>
      logs
        .deleteLogGroup({ logGroupName })
        .pipe(Effect.catchTag("ResourceNotFoundException", () => Effect.void)),
    { concurrency: 4, discard: true },
  );
});

// Explicitly-typed retry wrappers — an inline `Effect.retry` in provider
// lifecycle code leaks `Retry.Return`'s conditional type into declaration
// emit and widens the provider layer to `unknown` for every consumer of
// `AWS.providers()`.

/**
 * Retry through Deadline `ConflictException` (STATUS_CONFLICT while a
 * sub-resource drains or a concurrent mutation settles). Bounded.
 */
export const retryWhileConflict = <A, E extends { readonly _tag: string }, R>(
  self: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
  Effect.retry(self, {
    while: (e) => e._tag === "ConflictException",
    schedule: Schedule.spaced("5 seconds").pipe(
      Schedule.both(Schedule.recurs(10)),
    ),
  });

/**
 * A freshly-created farm rejects sub-resource mutations for a short window:
 * "Farm ... infrastructure setup in progress" surfaces as a 429
 * `ThrottlingException` or a `ConflictException`, and the farm's internal
 * components (e.g. its BudgetTracker) surface as `ResourceNotFoundException`
 * before they are provisioned. Bounded retry through the settling window
 * (~60s). Genuine throttling is also safely absorbed here.
 */
export const retryWhileFarmSettling = <
  A,
  E extends { readonly _tag: string },
  R,
>(
  self: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
  Effect.retry(self, {
    while: (e) =>
      e._tag === "ConflictException" ||
      e._tag === "ResourceNotFoundException" ||
      e._tag === "ThrottlingException",
    schedule: Schedule.spaced("3 seconds").pipe(
      Schedule.both(Schedule.recurs(20)),
    ),
  });

/**
 * A freshly-created IAM role may not have propagated when Deadline validates
 * it — createFleet/createMonitor surface this as AccessDeniedException.
 * Bounded retry through the propagation window (~60s).
 */
export const retryThroughIamPropagation = <
  A,
  E extends { readonly _tag: string },
  R,
>(
  self: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
  Effect.retry(self, {
    while: (e) => e._tag === "AccessDeniedException",
    schedule: Schedule.spaced("5 seconds").pipe(
      Schedule.both(Schedule.recurs(12)),
    ),
  });
