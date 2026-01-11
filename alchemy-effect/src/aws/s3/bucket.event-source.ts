import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import type { Event } from "distilled-aws/s3";
import { Binding } from "../../binding.ts";
import type { From } from "../../policy.ts";
import type { OnBucketEvent, S3EventType } from "./bucket.on-event.ts";
import { Bucket } from "./bucket.ts";
import { Function, type FunctionBinding } from "../lambda/function.ts";
import { Account } from "../account.ts";
import * as s3 from "distilled-aws/s3";
import * as lambda from "distilled-aws/lambda";

export interface BucketEventSourceProps {
  /**
   * S3 event types to trigger the Lambda function.
   * @default - ["s3:ObjectCreated:*"]
   */
  events?: S3EventType[];
  /**
   * Only trigger for objects with keys starting with this prefix.
   */
  filterPrefix?: string;
  /**
   * Only trigger for objects with keys ending with this suffix.
   */
  filterSuffix?: string;
}

export interface BucketEventSourceAttr extends FunctionBinding {
  /**
   * Unique ID for this notification configuration.
   */
  notificationId: string;
}

export interface BucketEventSource<
  B extends Bucket,
  Props extends BucketEventSourceProps,
> extends Binding<
  Function,
  OnBucketEvent<From<B>>,
  Props,
  BucketEventSourceAttr,
  "BucketEventSource"
> {}

export const BucketEventSource = Binding<
  <B extends Bucket, const Props extends BucketEventSourceProps>(
    bucket: B,
    props?: Props,
  ) => BucketEventSource<B, Props>
>(Function, "AWS.S3.OnBucketEvent", "BucketEventSource");

export const bucketEventSourceProvider = () =>
  BucketEventSource.provider.effect(
    Effect.gen(function* () {
      const accountId = yield* Account;

      return {
        // Attach returns the function binding info
        attach: ({ source: bucket, attr }) => ({
          notificationId: attr?.notificationId ?? `alchemy-${bucket.id}`,
          // No policyStatements needed - S3 invokes Lambda directly via resource-based policy
        }),

        // Post-attach: Add Lambda permission and configure S3 bucket notification
        postattach: Effect.fn(function* ({
          source: bucket,
          props: {
            events = ["s3:ObjectCreated:*"],
            filterPrefix,
            filterSuffix,
          } = {},
          attr,
          target: {
            attr: { functionArn, functionName },
          },
        }) {
          const notificationId = attr?.notificationId ?? `alchemy-${bucket.id}`;

          // Add Lambda permission allowing S3 to invoke this function
          yield* lambda
            .addPermission({
              FunctionName: functionName,
              StatementId: `s3-invoke-${bucket.id}`,
              Action: "lambda:InvokeFunction",
              Principal: "s3.amazonaws.com",
              SourceArn: bucket.attr.bucketArn,
              SourceAccount: accountId,
            })
            .pipe(
              Effect.catchTag("ResourceConflictException", () => Effect.void),
              Effect.orDie,
            );

          // Get existing notification configuration
          const existing = yield* s3
            .getBucketNotificationConfiguration({
              Bucket: bucket.attr.bucketName,
            })
            .pipe(Effect.orDie);

          // Build filter rules
          const filterRules: Array<{
            Name: "prefix" | "suffix";
            Value: string;
          }> = [];
          if (filterPrefix)
            filterRules.push({ Name: "prefix", Value: filterPrefix });
          if (filterSuffix)
            filterRules.push({ Name: "suffix", Value: filterSuffix });

          // Create new Lambda notification config
          const newLambdaConfig = {
            Id: notificationId,
            LambdaFunctionArn: functionArn,
            Events: events as Event[],
            Filter:
              filterRules.length > 0
                ? { Key: { FilterRules: filterRules } }
                : undefined,
          };

          // Merge with existing configs (replace if same ID exists)
          const lambdaConfigs = [
            ...(existing.LambdaFunctionConfigurations ?? []).filter(
              (c) => c.Id !== notificationId,
            ),
            newLambdaConfig,
          ];

          // Put merged notification configuration
          yield* s3
            .putBucketNotificationConfiguration({
              Bucket: bucket.attr.bucketName,
              NotificationConfiguration: {
                ...existing,
                LambdaFunctionConfigurations: lambdaConfigs,
              },
            })
            .pipe(
              Effect.retry({
                // S3 may take time to recognize Lambda permission
                while: (e) =>
                  e.message?.includes("Unable to validate") ?? false,
                schedule: Schedule.exponential(100),
              }),
              Effect.orDie,
            );

          return {
            ...attr,
            notificationId,
          };
        }),

        // Detach: Remove notification and Lambda permission
        detach: Effect.fn(function* ({
          source: bucket,
          target: {
            attr: { functionName },
          },
          attr,
        }) {
          const notificationId = attr?.notificationId ?? `alchemy-${bucket.id}`;

          // Remove notification configuration
          const existing = yield* s3
            .getBucketNotificationConfiguration({
              Bucket: bucket.attr.bucketName,
            })
            .pipe(
              Effect.catchAll(() =>
                Effect.succeed({} as { LambdaFunctionConfigurations?: any[] }),
              ),
            );

          if (existing.LambdaFunctionConfigurations?.length) {
            yield* s3
              .putBucketNotificationConfiguration({
                Bucket: bucket.attr.bucketName,
                NotificationConfiguration: {
                  ...existing,
                  LambdaFunctionConfigurations:
                    existing.LambdaFunctionConfigurations.filter(
                      (c) => c.Id !== notificationId,
                    ),
                },
              })
              .pipe(Effect.catchAll(() => Effect.void));
          }

          // Remove Lambda permission
          yield* lambda
            .removePermission({
              FunctionName: functionName,
              StatementId: `s3-invoke-${bucket.id}`,
            })
            .pipe(Effect.catchAll(() => Effect.void));
        }),
      };
    }),
  );
