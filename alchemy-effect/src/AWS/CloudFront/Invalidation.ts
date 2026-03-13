import * as cloudfront from "@distilled.cloud/aws/cloudfront";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { Resource } from "../../Resource.ts";

export interface InvalidationProps {
  /**
   * Distribution to invalidate.
   */
  distributionId: string;
  /**
   * Version string used as the invalidation caller reference. Change this value
   * to trigger a new invalidation.
   */
  version: string;
  /**
   * Paths to invalidate.
   * @default ["/*"]
   */
  paths?: string[];
  /**
   * Wait for the invalidation to complete.
   * @default false
   */
  wait?: boolean;
}

export interface Invalidation extends Resource<
  "AWS.CloudFront.Invalidation",
  InvalidationProps,
  {
    invalidationId: string;
    distributionId: string;
    version: string;
    status: string;
    paths: string[];
    createTime: Date | undefined;
  }
> {}

/**
 * A CloudFront cache invalidation request.
 *
 * `Invalidation` is a helper resource for website deployments that need to
 * clear selected CloudFront cache paths after asset updates.
 *
 * @section Creating Invalidations
 * @example Invalidate The Entire Distribution
 * ```typescript
 * const invalidation = yield* Invalidation("WebsiteInvalidation", {
 *   distributionId: distribution.distributionId,
 *   version: files.version,
 * });
 * ```
 */
export const Invalidation = Resource<Invalidation>("AWS.CloudFront.Invalidation");

const defaultPaths = ["/*"];

export const InvalidationProvider = () =>
  Invalidation.provider.effect(
    Effect.gen(function* () {
      const waitForCompletion = Effect.fn(function* (
        distributionId: string,
        invalidationId: string,
      ) {
        return yield* cloudfront.getInvalidation({
          DistributionId: distributionId,
          Id: invalidationId,
        }).pipe(
          Effect.map((response) => response.Invalidation),
          Effect.flatMap((invalidation) =>
            invalidation?.Status === "Completed"
              ? Effect.succeed(invalidation)
              : Effect.fail(new Error("InvalidationInProgress"))
          ),
          Effect.retry({
            while: (error) =>
              error instanceof Error && error.message === "InvalidationInProgress",
            schedule: Schedule.fixed("2 seconds").pipe(
              Schedule.both(Schedule.recurs(120)),
            ),
          }),
        );
      });

      const createInvalidation = Effect.fn(function* (props: InvalidationProps) {
        const response = yield* cloudfront.createInvalidation({
          DistributionId: props.distributionId,
          InvalidationBatch: {
            CallerReference: props.version,
            Paths: {
              Quantity: (props.paths ?? defaultPaths).length,
              Items: props.paths ?? defaultPaths,
            },
          },
        });

        const invalidation = props.wait
          ? yield* waitForCompletion(
              props.distributionId,
              response.Invalidation?.Id!,
            )
          : response.Invalidation;

        if (!invalidation?.Id) {
          return yield* Effect.fail(
            new Error("createInvalidation returned no invalidation"),
          );
        }

        return invalidation;
      });

      return {
        stables: ["distributionId", "version"],
        diff: Effect.fn(function* ({ olds, news }) {
          if (
            olds.distributionId !== news.distributionId ||
            olds.version !== news.version
          ) {
            return { action: "replace" } as const;
          }
        }),
        create: Effect.fn(function* ({ news, session }) {
          const invalidation = yield* createInvalidation(news);
          yield* session.note(invalidation.Id);
          return {
            invalidationId: invalidation.Id,
            distributionId: news.distributionId,
            version: news.version,
            status: invalidation.Status ?? "InProgress",
            paths: news.paths ?? defaultPaths,
            createTime: invalidation.CreateTime,
          };
        }),
        update: Effect.fn(function* ({ news, session }) {
          const invalidation = yield* createInvalidation(news);
          yield* session.note(invalidation.Id);
          return {
            invalidationId: invalidation.Id,
            distributionId: news.distributionId,
            version: news.version,
            status: invalidation.Status ?? "InProgress",
            paths: news.paths ?? defaultPaths,
            createTime: invalidation.CreateTime,
          };
        }),
        delete: Effect.fn(function* () {}),
      };
    }),
  );
