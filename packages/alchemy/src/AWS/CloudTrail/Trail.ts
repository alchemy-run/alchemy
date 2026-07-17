import * as cloudtrail from "@distilled.cloud/aws/cloudtrail";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { createInternalTags, diffTags, hasAlchemyTags } from "../../Tags.ts";
import { AWSEnvironment, type AccountID } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import type { RegionID } from "../Region.ts";

export type TrailName = string;
export type TrailArn =
  `arn:aws:cloudtrail:${RegionID}:${AccountID}:trail/${TrailName}`;

/**
 * A data-event selector for a CloudTrail trail. Data resources scope logging to
 * object-level operations on specific resource types (e.g. S3 objects, Lambda
 * invocations).
 */
export interface TrailDataResource {
  /**
   * The resource type on which to log data events, e.g.
   * `AWS::S3::Object` or `AWS::Lambda::Function`.
   */
  type: string;
  /**
   * The list of ARN-like values that specify the objects/functions to log.
   */
  values?: string[];
}

/**
 * A basic event selector describing which management and data events a trail
 * captures. Mutually exclusive with advanced event selectors (not modeled).
 */
export interface TrailEventSelector {
  /**
   * Whether to log read-only, write-only, or all management/data events.
   * @default "All"
   */
  readWriteType?: "ReadOnly" | "WriteOnly" | "All";
  /**
   * Whether the selector includes management events.
   * @default true
   */
  includeManagementEvents?: boolean;
  /**
   * Data-event resources to log.
   */
  dataResources?: TrailDataResource[];
  /**
   * Management event sources to exclude, e.g. `kms.amazonaws.com`.
   */
  excludeManagementEventSources?: string[];
}

export interface TrailProps {
  /**
   * Name of the trail. Must start with a letter, be 3-128 characters, and
   * contain only letters, numbers, periods, underscores, or dashes. Changing
   * the name replaces the trail.
   * @default ${app}-${stage}-${id}
   */
  trailName?: string;
  /**
   * Name of the S3 bucket that receives the log files. The bucket must have a
   * policy granting `cloudtrail.amazonaws.com` `s3:GetBucketAcl` and
   * `s3:PutObject`.
   */
  s3BucketName: string;
  /**
   * S3 key prefix prepended to the delivered log-file object keys.
   */
  s3KeyPrefix?: string;
  /**
   * Name of an existing Amazon SNS topic to notify when a log file is
   * delivered.
   */
  snsTopicName?: string;
  /**
   * Whether the trail publishes events from global services such as IAM and
   * STS.
   * @default true
   */
  includeGlobalServiceEvents?: boolean;
  /**
   * Whether the trail logs events from all regions.
   * @default false
   */
  isMultiRegionTrail?: boolean;
  /**
   * Whether log file integrity validation is enabled, producing digest files
   * you can use to verify logs were not tampered with.
   * @default false
   */
  enableLogFileValidation?: boolean;
  /**
   * ARN of a CloudWatch Logs log group to which CloudTrail also delivers
   * events. Requires `cloudWatchLogsRoleArn`.
   */
  cloudWatchLogsLogGroupArn?: string;
  /**
   * ARN of the IAM role CloudTrail assumes to write to the CloudWatch Logs log
   * group.
   */
  cloudWatchLogsRoleArn?: string;
  /**
   * The KMS key ID/alias/ARN used to encrypt delivered log files (SSE-KMS).
   */
  kmsKeyId?: string;
  /**
   * Whether the trail applies to the whole AWS Organization (management account
   * or delegated admin only).
   * @default false
   */
  isOrganizationTrail?: boolean;
  /**
   * Whether logging is enabled. When `true` the trail begins delivering events;
   * when `false` logging is stopped.
   * @default true
   */
  enableLogging?: boolean;
  /**
   * Basic event selectors controlling which management/data events are logged.
   * When omitted the trail keeps CloudTrail's default (log all management
   * events).
   */
  eventSelectors?: TrailEventSelector[];
  /**
   * Tags to apply to the trail. Merged with internal Alchemy tags.
   */
  tags?: Record<string, string>;
}

export interface Trail extends Resource<
  "AWS.CloudTrail.Trail",
  TrailProps,
  {
    trailName: TrailName;
    trailArn: TrailArn;
    homeRegion: string;
    s3BucketName: string;
  },
  never,
  Providers
> {}

/**
 * An AWS CloudTrail trail that delivers a record of account activity to an S3
 * bucket (and optionally CloudWatch Logs).
 *
 * A trail name is auto-generated from the app, stage, and logical ID unless you
 * provide one. The destination S3 bucket must carry a bucket policy authorizing
 * `cloudtrail.amazonaws.com` to write objects.
 * @resource
 * @section Creating a Trail
 * @example Single-region trail
 * ```typescript
 * import * as CloudTrail from "alchemy/AWS/CloudTrail";
 *
 * const trail = yield* CloudTrail.Trail("AuditTrail", {
 *   s3BucketName: bucket.bucketName,
 * });
 * ```
 *
 * @example Multi-region trail with log file validation
 * ```typescript
 * const trail = yield* CloudTrail.Trail("OrgAudit", {
 *   s3BucketName: bucket.bucketName,
 *   isMultiRegionTrail: true,
 *   includeGlobalServiceEvents: true,
 *   enableLogFileValidation: true,
 * });
 * ```
 *
 * @section Event Selectors
 * @example Log S3 object-level data events
 * ```typescript
 * const trail = yield* CloudTrail.Trail("DataEvents", {
 *   s3BucketName: bucket.bucketName,
 *   eventSelectors: [
 *     {
 *       readWriteType: "All",
 *       includeManagementEvents: true,
 *       dataResources: [{ type: "AWS::S3::Object", values: ["arn:aws:s3"] }],
 *     },
 *   ],
 * });
 * ```
 *
 * @section Pausing Logging
 * @example Create a trail but leave logging stopped
 * ```typescript
 * const trail = yield* CloudTrail.Trail("Paused", {
 *   s3BucketName: bucket.bucketName,
 *   enableLogging: false,
 * });
 * ```
 */
export const Trail = Resource<Trail>("AWS.CloudTrail.Trail");

const toEventSelectors = (
  selectors: TrailEventSelector[],
): cloudtrail.EventSelector[] =>
  selectors.map((s) => ({
    ReadWriteType: s.readWriteType,
    IncludeManagementEvents: s.includeManagementEvents,
    DataResources: s.dataResources?.map((d) => ({
      Type: d.type,
      Values: d.values,
    })),
    ExcludeManagementEventSources: s.excludeManagementEventSources,
  }));

export const TrailProvider = () =>
  Provider.effect(
    Trail,
    Effect.gen(function* () {
      const createTrailName = Effect.fn(function* (
        id: string,
        props: { trailName?: string | undefined },
      ) {
        return (
          props.trailName ?? (yield* createPhysicalName({ id, maxLength: 128 }))
        );
      });

      // Observed tags for a trail, keyed as a plain record. CloudTrail's
      // ListTags returns a per-resource list; a trail can vanish between the
      // describe and the tag read (ResourceNotFoundException), so tag reads
      // tolerate every failure — tags are a best-effort observation here.
      const fetchTrailTags = (trailArn: string) =>
        cloudtrail.listTags({ ResourceIdList: [trailArn] }).pipe(
          Effect.map((r) => {
            const list = r.ResourceTagList?.[0]?.TagsList ?? [];
            return Object.fromEntries(
              list.map((t) => [t.Key, t.Value ?? ""] as const),
            ) as Record<string, string>;
          }),
          Effect.catch(() => Effect.succeed({} as Record<string, string>)),
        );

      return Trail.Provider.of({
        stables: ["trailName", "trailArn", "homeRegion"],
        // Enumerate every trail visible in the ambient region. `describeTrails`
        // (with no names) returns the full trail list; shadow trails from other
        // home regions are included, which is the correct account/region view.
        list: () =>
          Effect.gen(function* () {
            const { accountId, region } = yield* AWSEnvironment.current;
            const resp = yield* cloudtrail.describeTrails({});
            return (resp.trailList ?? []).flatMap((t) => {
              if (!t.Name) return [];
              const trailArn = (t.TrailARN ??
                `arn:aws:cloudtrail:${region}:${accountId}:trail/${t.Name}`) as TrailArn;
              return [
                {
                  trailName: t.Name,
                  trailArn,
                  homeRegion: t.HomeRegion ?? region,
                  s3BucketName: t.S3BucketName ?? "",
                },
              ];
            });
          }),
        read: Effect.fn(function* ({ id, olds, output }) {
          const { accountId, region } = yield* AWSEnvironment.current;
          const trailName =
            output?.trailName ?? (yield* createTrailName(id, olds ?? {}));
          const found = yield* cloudtrail.getTrail({ Name: trailName }).pipe(
            Effect.map((r) => r.Trail),
            Effect.catchTag("TrailNotFoundException", () =>
              Effect.succeed(undefined),
            ),
          );
          if (!found) return undefined;
          const trailArn = (found.TrailARN ??
            `arn:aws:cloudtrail:${region}:${accountId}:trail/${trailName}`) as TrailArn;
          const attrs = {
            trailName,
            trailArn,
            homeRegion: found.HomeRegion ?? region,
            s3BucketName: found.S3BucketName ?? "",
          };
          const tags = yield* fetchTrailTags(trailArn);
          return (yield* hasAlchemyTags(id, tags)) ? attrs : Unowned(attrs);
        }),
        diff: Effect.fn(function* ({ id, news, olds }) {
          if (!isResolved(news)) return undefined;
          const oldName = yield* createTrailName(id, olds ?? {});
          const newName = yield* createTrailName(id, news);
          if (oldName !== newName) {
            return { action: "replace" } as const;
          }
          // fall through — updateTrail handles every other mutable property
        }),
        reconcile: Effect.fn(function* ({ id, news, output, session }) {
          const { accountId, region } = yield* AWSEnvironment.current;
          const trailName =
            output?.trailName ?? (yield* createTrailName(id, news));
          const internalTags = yield* createInternalTags(id);

          const settings = {
            S3BucketName: news.s3BucketName,
            S3KeyPrefix: news.s3KeyPrefix,
            SnsTopicName: news.snsTopicName,
            IncludeGlobalServiceEvents: news.includeGlobalServiceEvents,
            IsMultiRegionTrail: news.isMultiRegionTrail,
            EnableLogFileValidation: news.enableLogFileValidation,
            CloudWatchLogsLogGroupArn: news.cloudWatchLogsLogGroupArn,
            CloudWatchLogsRoleArn: news.cloudWatchLogsRoleArn,
            KmsKeyId: news.kmsKeyId,
            IsOrganizationTrail: news.isOrganizationTrail,
          };

          // 1. OBSERVE — the trail is authoritative; output only caches the id.
          let live = yield* cloudtrail.getTrail({ Name: trailName }).pipe(
            Effect.map((r) => r.Trail),
            Effect.catchTag("TrailNotFoundException", () =>
              Effect.succeed(undefined),
            ),
          );

          // 2. ENSURE — create if missing; a just-created S3 bucket policy can
          // be transiently invisible to CloudTrail, surfacing as
          // InsufficientS3BucketPolicyException — a consistency race, so retry.
          if (live === undefined) {
            live = yield* cloudtrail
              .createTrail({
                Name: trailName,
                ...settings,
                TagsList: Object.entries({
                  ...news.tags,
                  ...internalTags,
                }).map(([Key, Value]) => ({ Key, Value })),
              })
              .pipe(
                Effect.retry({
                  while: (e) =>
                    e._tag === "InsufficientS3BucketPolicyException" ||
                    e._tag === "S3BucketDoesNotExistException",
                  schedule: Schedule.max([
                    Schedule.fixed(2000),
                    Schedule.recurs(15),
                  ]),
                }),
                Effect.catchTag("TrailAlreadyExistsException", () =>
                  cloudtrail
                    .getTrail({ Name: trailName })
                    .pipe(Effect.map((r) => r.Trail!)),
                ),
              );
          } else {
            // 3a. SYNC settings — updateTrail is an idempotent upsert.
            yield* cloudtrail.updateTrail({ Name: trailName, ...settings });
          }

          const trailArn = (live.TrailARN ??
            `arn:aws:cloudtrail:${region}:${accountId}:trail/${trailName}`) as TrailArn;

          // 3b. SYNC event selectors — only when the user specified them.
          if (news.eventSelectors !== undefined) {
            yield* cloudtrail.putEventSelectors({
              TrailName: trailName,
              EventSelectors: toEventSelectors(news.eventSelectors),
            });
          }

          // 3c. SYNC tags — diff against observed cloud tags so adoption and
          // out-of-band drift both converge.
          const currentTags = yield* fetchTrailTags(trailArn);
          const { upsert, removed } = diffTags(currentTags, {
            ...news.tags,
            ...internalTags,
          });
          if (upsert.length > 0) {
            yield* cloudtrail.addTags({
              ResourceId: trailArn,
              TagsList: upsert.map((t) => ({ Key: t.Key, Value: t.Value })),
            });
          }
          if (removed.length > 0) {
            yield* cloudtrail.removeTags({
              ResourceId: trailArn,
              TagsList: removed.map((Key) => ({ Key })),
            });
          }

          // 3d. SYNC logging state — read observed status, apply the delta.
          const desiredLogging = news.enableLogging ?? true;
          const isLogging = yield* cloudtrail
            .getTrailStatus({ Name: trailName })
            .pipe(Effect.map((r) => r.IsLogging ?? false));
          if (desiredLogging && !isLogging) {
            yield* cloudtrail.startLogging({ Name: trailName });
          } else if (!desiredLogging && isLogging) {
            yield* cloudtrail.stopLogging({ Name: trailName });
          }

          yield* session.note(trailArn);
          return {
            trailName,
            trailArn,
            // A trail's home region is the region it was created in — always
            // the ambient region here (createTrail runs region-scoped).
            homeRegion: region,
            s3BucketName: live.S3BucketName ?? news.s3BucketName,
          };
        }),
        delete: Effect.fn(function* ({ output }) {
          // Stop logging first (best effort), then delete. Both are idempotent.
          yield* cloudtrail
            .stopLogging({ Name: output.trailName })
            .pipe(Effect.catchTag("TrailNotFoundException", () => Effect.void));
          yield* cloudtrail
            .deleteTrail({ Name: output.trailName })
            .pipe(Effect.catchTag("TrailNotFoundException", () => Effect.void));
        }),
      });
    }),
  );
