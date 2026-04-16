import { Credentials } from "@distilled.cloud/aws/Credentials";
import { Region } from "@distilled.cloud/aws/Region";
import * as S3 from "@distilled.cloud/aws/s3";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";
import type { HttpClient } from "effect/unstable/http/HttpClient";
import { DotAlchemy } from "../Config.ts";
import { decodeFqn, encodeFqn } from "../FQN.ts";
import { isResource } from "../Resource.ts";
import type { ResourceState } from "./ResourceState.ts";
import { State, StateStoreError, type StateService } from "./State.ts";

/**
 * Options for the S3 state backend.
 */
export interface S3StateOptions {
  /**
   * Name of the S3 bucket that holds alchemy state.
   *
   * The bucket must already exist. S3State will not create it: the bucket
   * that stores the stack's state cannot be a resource inside that same
   * stack (chicken-and-egg). Provision it out-of-band (e.g. via a separate
   * one-time IaC step, the AWS console, or `aws s3 mb`).
   */
  bucketName: string;
  /**
   * Prefix prepended to every object key. Trailing slash is optional and
   * will be normalized.
   *
   * Lets multiple stacks share a single state bucket by namespacing keys.
   *
   * @default "alchemy/"
   */
  prefix?: string;
}

const DEFAULT_PREFIX = "alchemy/";

const normalizePrefix = (prefix: string | undefined): string => {
  if (!prefix || prefix.length === 0) return DEFAULT_PREFIX;
  return prefix.endsWith("/") ? prefix : `${prefix}/`;
};

const serializeResourceState = (value: ResourceState): string =>
  JSON.stringify(
    value,
    (_, v) => {
      if (isResource(v)) {
        return {
          id: v.LogicalId,
          type: v.Type,
          props: v.Props,
          attr: v.Attributes,
        };
      }
      return v;
    },
    2,
  );

const bodyToString = (body: S3.GetObjectOutput["Body"]) =>
  body === undefined
    ? Effect.succeed("")
    : (body as Stream.Stream<Uint8Array, Error, never>).pipe(
        Stream.decodeText({ encoding: "utf-8" }),
        Stream.mkString,
      );

const wrapError = (message: string) => (cause: unknown) =>
  new StateStoreError({
    message: `${message}: ${
      (cause as any)?._tag ?? (cause as any)?.message ?? String(cause)
    }`,
    cause: cause instanceof Error ? cause : undefined,
  });

/**
 * If the S3 prefix is empty but the local `.alchemy/state/` directory is
 * not, log a one-shot warning suggesting the user may want to lift their
 * existing state before deploying. All services are picked up via
 * `serviceOption` so the check silently no-ops in environments where
 * `DotAlchemy`, `FileSystem`, or `Path` aren't in scope (e.g. tests).
 */
const warnOnStaleLocalState = (bucketName: string, prefix: string) =>
  Effect.gen(function* () {
    const dotAlchemyOpt = yield* Effect.serviceOption(DotAlchemy);
    const fsOpt = yield* Effect.serviceOption(FileSystem.FileSystem);
    const pathOpt = yield* Effect.serviceOption(Path.Path);

    if (
      Option.isNone(dotAlchemyOpt) ||
      Option.isNone(fsOpt) ||
      Option.isNone(pathOpt)
    ) {
      return;
    }

    const fs = fsOpt.value;
    const stateDir = pathOpt.value.join(dotAlchemyOpt.value, "state");

    const exists = yield* fs
      .exists(stateDir)
      .pipe(Effect.catch(() => Effect.succeed(false)));
    if (!exists) return;

    const entries = yield* fs
      .readDirectory(stateDir)
      .pipe(Effect.catch(() => Effect.succeed<readonly string[]>([])));
    if (entries.length === 0) return;

    yield* Effect.logWarning(
      `S3State: bucket '${bucketName}' has no objects under '${prefix}' ` +
        `but local state exists at '${stateDir}'. Deploying now will treat ` +
        `every resource as new and may duplicate cloud resources. To migrate ` +
        `existing state, run before deploying:\n` +
        `  aws s3 cp --recursive ${stateDir}/ s3://${bucketName}/${prefix}`,
    );
  });

/**
 * State backend backed by an S3 bucket.
 *
 * Object key layout: `${prefix}${stack}/${stage}/${encodeFqn(fqn)}.json`.
 * Matches the serialization used by LocalState so state written by one
 * backend is readable by the other.
 *
 * Credentials, Region, and HttpClient are resolved from the ambient
 * context — typically wired up by `AWS.providers()` and the associated
 * `Credentials.from*()` / `Region.from*()` layers. To pin the state
 * bucket to a region different from the stack's deploy region, provide
 * `Region` explicitly:
 *
 * ```ts
 * import { Region } from "@distilled.cloud/aws/Region";
 * import { S3State } from "alchemy/State";
 *
 * const state = Layer.provide(
 *   S3State({ bucketName: "my-infra-state" }),
 *   Layer.succeed(Region, "us-east-1"),
 * );
 * ```
 *
 * @example
 * ```ts
 * import * as Alchemy from "alchemy";
 * import * as AWS from "alchemy/AWS";
 * import { S3State } from "alchemy/State";
 *
 * export default Alchemy.Stack(
 *   "my-stack",
 *   {
 *     providers: AWS.providers(),
 *     state: S3State({ bucketName: "my-infra-state" }),
 *   },
 *   Effect.gen(function* () { ... }),
 * );
 * ```
 */
export const S3State = (
  options: S3StateOptions,
): Layer.Layer<State, StateStoreError, Credentials | Region | HttpClient> => {
  const bucketName = options.bucketName;
  const prefix = normalizePrefix(options.prefix);

  return Layer.effect(
    State,
    Effect.gen(function* () {
      // Bind S3 operations — resolves Credentials | Region | HttpClient once
      // and captures them so the returned StateService methods have
      // `never` requirements. `.pages` / `.items` pagination streams live
      // on the unbound operation and still type their R channel, so we
      // also capture the AWS context here to feed them back in.
      const listObjectsV2 = yield* S3.listObjectsV2;
      const getObject = yield* S3.getObject;
      const putObject = yield* S3.putObject;
      const deleteObject = yield* S3.deleteObject;
      const awsContext = yield* Effect.context<
        Credentials | Region | HttpClient
      >();

      // Verify the bucket exists and is accessible. Fail loudly — the
      // bucket is a deploy-time prerequisite, not something alchemy
      // bootstraps for the user. The same probe also tells us whether
      // the state prefix is empty, which we use to surface a migration
      // warning if the user still has local state lying around.
      const probe = yield* listObjectsV2({
        Bucket: bucketName,
        Prefix: prefix,
        MaxKeys: 1,
      }).pipe(
        Effect.catchTag("NoSuchBucket", () =>
          Effect.fail(
            new StateStoreError({
              message:
                `S3 bucket '${bucketName}' does not exist. Create it before ` +
                `using S3State — the state bucket cannot be managed by the ` +
                `same stack it stores.`,
            }),
          ),
        ),
        Effect.mapError((err) =>
          err instanceof StateStoreError
            ? err
            : new StateStoreError({
                message: `Failed to access S3 bucket '${bucketName}': ${
                  (err as any)?._tag ?? (err as any)?.message ?? String(err)
                }`,
                cause: err instanceof Error ? err : undefined,
              }),
        ),
      );

      const prefixIsEmpty =
        (probe.Contents ?? []).length === 0 &&
        (probe.CommonPrefixes ?? []).length === 0;

      if (prefixIsEmpty) {
        yield* warnOnStaleLocalState(bucketName, prefix);
      }

      const stagePrefix = (stack: string, stage: string) =>
        `${prefix}${stack}/${stage}/`;

      const objectKey = (request: {
        stack: string;
        stage: string;
        fqn: string;
      }) =>
        `${stagePrefix(request.stack, request.stage)}${encodeFqn(request.fqn)}.json`;

      const stripCommonPrefix = (
        fullPrefix: string,
        commonPrefix: string | undefined,
      ): string | undefined => {
        if (!commonPrefix || !commonPrefix.startsWith(fullPrefix)) {
          return undefined;
        }
        const tail = commonPrefix.slice(fullPrefix.length);
        return tail.endsWith("/") ? tail.slice(0, -1) : tail;
      };

      const listDirectories = (fullPrefix: string) =>
        S3.listObjectsV2
          .pages({
            Bucket: bucketName,
            Prefix: fullPrefix,
            Delimiter: "/",
          })
          .pipe(
            Stream.runFold(
              () => new Set<string>(),
              (acc, page) => {
                for (const cp of page.CommonPrefixes ?? []) {
                  const name = stripCommonPrefix(fullPrefix, cp.Prefix);
                  if (name) acc.add(name);
                }
                return acc;
              },
            ),
            Effect.map((names) => Array.from(names)),
            Effect.mapError(wrapError("listObjectsV2 failed")),
            Effect.provide(awsContext),
          );

      const listResources = (stack: string, stage: string) => {
        const full = stagePrefix(stack, stage);
        return S3.listObjectsV2
          .pages({
            Bucket: bucketName,
            Prefix: full,
          })
          .pipe(
            Stream.runFold(
              () => [] as string[],
              (acc, page) => {
                for (const obj of page.Contents ?? []) {
                  if (!obj.Key?.endsWith(".json")) continue;
                  const filename = obj.Key.slice(full.length, -".json".length);
                  if (filename.length === 0) continue;
                  acc.push(decodeFqn(filename));
                }
                return acc;
              },
            ),
            Effect.mapError(wrapError("listObjectsV2 failed")),
            Effect.provide(awsContext),
          );
      };

      const state: StateService = {
        listStacks: () => listDirectories(prefix),

        listStages: (stack) => listDirectories(`${prefix}${stack}/`),

        get: (request) =>
          getObject({
            Bucket: bucketName,
            Key: objectKey(request),
          }).pipe(
            Effect.flatMap((res) => bodyToString(res.Body)),
            Effect.map((content) => JSON.parse(content) as ResourceState),
            Effect.catchTag("NoSuchKey", () =>
              Effect.succeed<ResourceState | undefined>(undefined),
            ),
            Effect.mapError(wrapError("getObject failed")),
          ),

        getReplacedResources: (request) =>
          Effect.gen(function* () {
            const fqns = yield* state.list(request);
            const all = yield* Effect.all(
              fqns.map((fqn) =>
                state.get({
                  stack: request.stack,
                  stage: request.stage,
                  fqn,
                }),
              ),
            );
            return all.filter(
              (r): r is Extract<ResourceState, { status: "replaced" }> =>
                r?.status === "replaced",
            );
          }),

        set: (request) =>
          putObject({
            Bucket: bucketName,
            Key: objectKey(request),
            Body: serializeResourceState(request.value),
            ContentType: "application/json",
          }).pipe(
            Effect.as(request.value),
            Effect.mapError(wrapError("putObject failed")),
          ),

        delete: (request) =>
          // S3 DeleteObject is idempotent: deleting a non-existent key
          // succeeds and does not surface NoSuchKey.
          deleteObject({
            Bucket: bucketName,
            Key: objectKey(request),
          }).pipe(
            Effect.asVoid,
            Effect.mapError(wrapError("deleteObject failed")),
          ),

        list: (request) => listResources(request.stack, request.stage),
      };

      return state;
    }),
  );
};
