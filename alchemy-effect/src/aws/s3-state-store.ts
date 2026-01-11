import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import {
  State,
  StateStoreError,
  type ResourceState,
  type ReplacedResourceState,
  type StateService,
} from "../state.ts";
import { isResource } from "../resource.ts";
import { S3Client } from "./s3.ts";

/**
 * Configuration for the S3 state store.
 */
export interface S3StateStoreConfig {
  /** The name of the S3 bucket to store state in */
  bucketName: string;
  /** The prefix for all state keys (defaults to "alchemy") */
  prefix?: string;
}

/**
 * Create an S3-backed state store Layer.
 *
 * @example
 * ```typescript
 * import * as S3StateStore from "alchemy-effect/aws/s3-state-store";
 *
 * export default defineStack("my-app", {
 *   resources: [Api],
 *   providers: AWS.providers(),
 *   state: S3StateStore.s3({
 *     bucketName: "my-alchemy-state-bucket",
 *     prefix: "alchemy", // optional
 *   }),
 * });
 * ```
 */
export const s3 = (config: S3StateStoreConfig) =>
  Layer.effect(
    State,
    Effect.gen(function* () {
      const s3Client = yield* S3Client;
      const prefix = config.prefix ?? "alchemy";
      const bucketName = config.bucketName;

      /**
       * Build the S3 key for a resource.
       * Format: {prefix}/{stack}/{stage}/{resourceId}.json
       */
      const resourceKey = ({
        stack,
        stage,
        resourceId,
      }: {
        stack: string;
        stage: string;
        resourceId: string;
      }) => `${prefix}/${stack}/${stage}/${resourceId}.json`;

      /**
       * Build the S3 prefix for a stage (for listing resources).
       * Format: {prefix}/{stack}/{stage}/
       */
      const stagePrefix = ({ stack, stage }: { stack: string; stage: string }) =>
        `${prefix}/${stack}/${stage}/`;

      /**
       * Build the S3 prefix for a stack (for listing stages).
       * Format: {prefix}/{stack}/
       */
      const stackPrefix = (stack: string) => `${prefix}/${stack}/`;

      /**
       * Convert an error to a StateStoreError.
       */
      const toStateStoreError = (err: unknown) =>
        new StateStoreError({
          message: err instanceof Error ? err.message : String(err),
        });

      /**
       * JSON serializer that handles Resource objects.
       * Matches the serialization in localFs implementation.
       */
      const serialize = (value: ResourceState) =>
        JSON.stringify(
          value,
          (k, v) => {
            if (isResource(v)) {
              return {
                id: v.id,
                type: v.type,
                props: v.props,
                attr: v.attr,
              };
            }
            return v;
          },
          2,
        );

      /**
       * Parse the response body from S3 GetObject.
       */
      const parseBody = (body: unknown): Effect.Effect<string, StateStoreError> =>
        Effect.gen(function* () {
          if (typeof body === "string") {
            return body;
          }
          if (body instanceof Uint8Array) {
            return new TextDecoder().decode(body);
          }
          if (body && typeof (body as any).text === "function") {
            return yield* Effect.promise(() => (body as any).text());
          }
          if (body && typeof (body as any).transformToString === "function") {
            return yield* Effect.promise(() =>
              (body as any).transformToString(),
            );
          }
          return yield* Effect.fail(
            new StateStoreError({
              message: "Unable to read S3 response body",
            }),
          );
        });

      const state: StateService = {
        /**
         * List all stacks in the state store.
         * Uses CommonPrefixes with delimiter to find unique stack names.
         */
        listStacks: () =>
          Effect.gen(function* () {
            const stacks: string[] = [];
            let continuationToken: string | undefined;

            do {
              const response = yield* s3Client
                .listObjectsV2({
                  Bucket: bucketName,
                  Prefix: `${prefix}/`,
                  Delimiter: "/",
                  ContinuationToken: continuationToken,
                })
                .pipe(Effect.catchAll((e) => Effect.fail(toStateStoreError(e))));

              if (response.CommonPrefixes) {
                for (const cp of response.CommonPrefixes) {
                  if (cp.Prefix) {
                    // Extract stack name from prefix like "alchemy/my-stack/"
                    const parts = cp.Prefix.split("/");
                    if (parts.length >= 2 && parts[1]) {
                      stacks.push(parts[1]);
                    }
                  }
                }
              }

              continuationToken = response.NextContinuationToken;
            } while (continuationToken);

            return stacks;
          }),

        /**
         * List all stages for a given stack.
         * Uses CommonPrefixes with delimiter to find unique stage names.
         */
        listStages: (stack: string) =>
          Effect.gen(function* () {
            const stages: string[] = [];
            let continuationToken: string | undefined;

            do {
              const response = yield* s3Client
                .listObjectsV2({
                  Bucket: bucketName,
                  Prefix: stackPrefix(stack),
                  Delimiter: "/",
                  ContinuationToken: continuationToken,
                })
                .pipe(Effect.catchAll((e) => Effect.fail(toStateStoreError(e))));

              if (response.CommonPrefixes) {
                for (const cp of response.CommonPrefixes) {
                  if (cp.Prefix) {
                    // Extract stage name from prefix like "alchemy/my-stack/prod/"
                    const parts = cp.Prefix.split("/");
                    if (parts.length >= 3 && parts[2]) {
                      stages.push(parts[2]);
                    }
                  }
                }
              }

              continuationToken = response.NextContinuationToken;
            } while (continuationToken);

            return stages;
          }),

        /**
         * Get the state for a specific resource.
         * Returns undefined if the resource doesn't exist.
         */
        get: (request) =>
          s3Client
            .getObject({
              Bucket: bucketName,
              Key: resourceKey(request),
            })
            .pipe(
              Effect.flatMap((response) => parseBody(response.Body)),
              Effect.map((body) => JSON.parse(body) as ResourceState),
              Effect.catchTag("NoSuchKey", () => Effect.succeed(undefined)),
              Effect.catchAll((e) => {
                // Handle case where error is already StateStoreError
                if (e instanceof StateStoreError) {
                  return Effect.fail(e);
                }
                // Check if it's a "not found" type error
                const err = e as any;
                if (
                  err?._tag === "NoSuchKey" ||
                  err?.name === "NoSuchKey" ||
                  err?.Code === "NoSuchKey"
                ) {
                  return Effect.succeed(undefined);
                }
                return Effect.fail(toStateStoreError(e));
              }),
            ),

        /**
         * Get all resources with "replaced" status for garbage collection.
         */
        getReplacedResources: (request) =>
          Effect.gen(function* () {
            const resourceIds = yield* state.list(request);
            const resources = yield* Effect.all(
              resourceIds.map((resourceId) =>
                state.get({
                  stack: request.stack,
                  stage: request.stage,
                  resourceId,
                }),
              ),
              { concurrency: "unbounded" },
            );
            return resources.filter(
              (r): r is ReplacedResourceState => r?.status === "replaced",
            );
          }),

        /**
         * Set the state for a specific resource.
         */
        set: <V extends ResourceState>(request: {
          stack: string;
          stage: string;
          resourceId: string;
          value: V;
        }) =>
          s3Client
            .putObject({
              Bucket: bucketName,
              Key: resourceKey(request),
              Body: serialize(request.value),
              ContentType: "application/json",
            })
            .pipe(
              Effect.map(() => request.value),
              Effect.catchAll((e) => Effect.fail(toStateStoreError(e))),
            ),

        /**
         * Delete the state for a specific resource.
         */
        delete: (request) =>
          s3Client
            .deleteObject({
              Bucket: bucketName,
              Key: resourceKey(request),
            })
            .pipe(
              Effect.map(() => undefined as void),
              // Ignore "not found" errors - resource might already be deleted
              Effect.catchTag("NoSuchKey", () => Effect.void),
              Effect.catchAll((e) => {
                const err = e as any;
                if (
                  err?._tag === "NoSuchKey" ||
                  err?.name === "NoSuchKey" ||
                  err?.Code === "NoSuchKey"
                ) {
                  return Effect.void;
                }
                return Effect.fail(toStateStoreError(e));
              }),
            ),

        /**
         * List all resource IDs for a given stack/stage.
         * Handles pagination for large result sets.
         */
        list: (request) =>
          Effect.gen(function* () {
            const resourceIds: string[] = [];
            let continuationToken: string | undefined;

            do {
              const response = yield* s3Client
                .listObjectsV2({
                  Bucket: bucketName,
                  Prefix: stagePrefix(request),
                  ContinuationToken: continuationToken,
                })
                .pipe(Effect.catchAll((e) => Effect.fail(toStateStoreError(e))));

              if (response.Contents) {
                for (const obj of response.Contents) {
                  if (obj.Key) {
                    // Extract resource ID from key like "alchemy/my-stack/prod/MyVpc.json"
                    const parts = obj.Key.split("/");
                    const filename = parts[parts.length - 1];
                    if (filename?.endsWith(".json")) {
                      resourceIds.push(filename.replace(/\.json$/, ""));
                    }
                  }
                }
              }

              continuationToken = response.NextContinuationToken;
            } while (continuationToken);

            return resourceIds;
          }),
      };

      return state;
    }),
  );
