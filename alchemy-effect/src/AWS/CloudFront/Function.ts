import * as cloudfront from "@distilled.cloud/aws/cloudfront";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import { Host, type ServerExecutionContext } from "../../Host.ts";
import * as Output from "../../Output.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import { Resource } from "../../Resource.ts";

export interface FunctionProps {
  /**
   * CloudFront Function name. If omitted, a deterministic name is generated.
   */
  name?: string;
  /**
   * CloudFront Function runtime.
   * @default "cloudfront-js-2.0"
   */
  runtime?: cloudfront.FunctionRuntime;
  /**
   * Optional function comment.
   */
  comment?: string;
  /**
   * JavaScript source code for the function.
   */
  code: string;
  /**
   * Optional associated KeyValueStore ARNs.
   */
  keyValueStoreArns?: string[];
  /**
   * Runtime environment captured through host bindings.
   */
  env?: Record<string, any>;
  /**
   * Optional export list kept for host compatibility.
   */
  exports?: string[];
}

export interface Function extends Resource<
  "AWS.CloudFront.Function",
  FunctionProps,
  {
    /**
     * CloudFront function ARN.
     */
    functionArn: string;
    /**
     * Function name.
     */
    functionName: string;
    /**
     * Runtime currently configured for the function.
     */
    runtime: cloudfront.FunctionRuntime;
    /**
     * Current comment.
     */
    comment: string;
    /**
     * Deployment stage for the function.
     */
    stage: cloudfront.FunctionStage;
    /**
     * Current status.
     */
    status: string;
    /**
     * Last modified time.
     */
    lastModifiedTime: Date | undefined;
    /**
     * Latest entity tag for update/delete operations.
     */
    etag: string | undefined;
    /**
     * Associated KeyValueStore ARNs.
     */
    keyValueStoreArns: string[];
  }
> {}

/**
 * A CloudFront Function for viewer request and response customization.
 *
 * CloudFront Functions are lightweight JavaScript handlers that run at the
 * edge and can be attached to distribution cache behaviors.
 *
 * @section Creating Functions
 * @example Viewer Request Function
 * ```typescript
 * const fn = yield* Function("RouterRequestFunction", {
 *   code: `
 * async function handler(event) {
 *   event.request.headers["x-forwarded-host"] = {
 *     value: event.request.headers.host.value,
 *   };
 *   return event.request;
 * }
 * `,
 * });
 * ```
 */
export const Function = Host<Function, ServerExecutionContext>(
  "AWS.CloudFront.Function",
  (id) => {
    const runners: Effect.Effect<void, never, any>[] = [];
    const env: Record<string, any> = {};

    return {
      type: "AWS.CloudFront.Function",
      id,
      env,
      set: (bindingId: string, output: Output.Output) =>
        Effect.sync(() => {
          const key = bindingId.replaceAll(/[^a-zA-Z0-9]/g, "_");
          env[key] = output.pipe(Output.map((value) => JSON.stringify(value)));
          return key;
        }),
      get: <T>(key: string) =>
        Config.string(key)
          .asEffect()
          .pipe(
            Effect.flatMap((value) =>
              Effect.try({
                try: () => JSON.parse(value) as T,
                catch: (error) => error as Error,
              }),
            ),
            Effect.catch((cause) =>
              Effect.die(
                new Error(`Failed to get environment variable: ${key}`, {
                  cause,
                }),
              ),
            ),
          ),
      run: ((effect: Effect.Effect<void, never, any>) =>
        Effect.sync(() => {
          runners.push(effect);
        })) as unknown as ServerExecutionContext["run"],
      exports: {
        program: Effect.all(runners, { concurrency: "unbounded" }).pipe(
          Effect.asVoid,
        ),
      },
    } satisfies ServerExecutionContext;
  },
);

const encoder = new TextEncoder();

const createName = (id: string, props: FunctionProps) =>
  props.name
    ? Effect.succeed(props.name)
    : createPhysicalName({
        id,
        maxLength: 64,
        lowercase: true,
      });

const toKvAssociations = (arns: string[] | undefined): cloudfront.KeyValueStoreAssociations | undefined =>
  arns && arns.length > 0
    ? {
        Quantity: arns.length,
        Items: arns.map((KeyValueStoreARN) => ({ KeyValueStoreARN })),
      }
    : undefined;

const toAttrs = (
  summary: cloudfront.FunctionSummary,
  etag: string | undefined,
  fallbackName: string,
): Function["Attributes"] => ({
  functionArn: summary.FunctionMetadata.FunctionARN,
  functionName: summary.Name || fallbackName,
  runtime: summary.FunctionConfig.Runtime,
  comment: summary.FunctionConfig.Comment,
  stage: summary.FunctionMetadata.Stage ?? "DEVELOPMENT",
  status: summary.Status ?? "UNKNOWN",
  lastModifiedTime: summary.FunctionMetadata.LastModifiedTime,
  etag,
  keyValueStoreArns:
    summary.FunctionConfig.KeyValueStoreAssociations?.Items?.flatMap((item) =>
      item.KeyValueStoreARN ? [item.KeyValueStoreARN] : [],
    ) ?? [],
});

export const FunctionProvider = () =>
  Function.provider.effect(
    Effect.gen(function* () {
      const describe = Effect.fn(function* (
        name: string,
        stage?: cloudfront.FunctionStage,
      ) {
        return yield* cloudfront
          .describeFunction({
            Name: name,
            Stage: stage,
          })
          .pipe(
            Effect.catchTag("NoSuchFunctionExists", () => Effect.succeed(undefined)),
          );
      });

      const getCurrent = Effect.fn(function* (name: string) {
        const live = yield* describe(name, "LIVE");
        if (live?.FunctionSummary) {
          return live;
        }
        return yield* describe(name, "DEVELOPMENT");
      });

      const getDevelopmentEtag = Effect.fn(function* (name: string) {
        const current = yield* describe(name, "DEVELOPMENT");
        return current?.ETag;
      });

      const publish = Effect.fn(function* (name: string, etag: string | undefined) {
        if (!etag) {
          return yield* Effect.fail(
            new Error(`CloudFront Function '${name}' is missing an ETag for publish`),
          );
        }
        yield* cloudfront.publishFunction({
          Name: name,
          IfMatch: etag,
        });
        return yield* describe(name, "LIVE");
      });

      return {
        stables: ["functionArn", "functionName"],
        diff: Effect.fn(function* ({ id, olds, news }) {
          if ((yield* createName(id, olds ?? {})) !== (yield* createName(id, news))) {
            return { action: "replace" } as const;
          }
        }),
        read: Effect.fn(function* ({ id, olds, output }) {
          const name = output?.functionName ?? (yield* createName(id, olds ?? {}));
          const current = yield* getCurrent(name);
          if (!current?.FunctionSummary) {
            return undefined;
          }
          return toAttrs(current.FunctionSummary, current.ETag, name);
        }),
        create: Effect.fn(function* ({ id, news, session }) {
          const name = yield* createName(id, news);
          const created = yield* cloudfront
            .createFunction({
              Name: name,
              FunctionConfig: {
                Comment: news.comment ?? "",
                Runtime: news.runtime ?? "cloudfront-js-2.0",
                KeyValueStoreAssociations: toKvAssociations(news.keyValueStoreArns),
              },
              FunctionCode: encoder.encode(news.code),
            })
            .pipe(
              Effect.catchTag("FunctionAlreadyExists", () =>
                describe(name, "DEVELOPMENT").pipe(
                  Effect.flatMap((existing) =>
                    existing
                      ? Effect.succeed(existing)
                      : Effect.fail(
                          new Error(
                            `CloudFront Function '${name}' already exists but could not be recovered`,
                          ),
                        ),
                  ),
                ),
              ),
            );

          const live = yield* publish(name, created.ETag);
          if (!live?.FunctionSummary) {
            return yield* Effect.fail(
              new Error("publishFunction returned no function summary"),
            );
          }

          yield* session.note(name);
          return toAttrs(live.FunctionSummary, live.ETag, name);
        }),
        update: Effect.fn(function* ({ news, output, session }) {
          yield* cloudfront.updateFunction({
            Name: output.functionName,
            IfMatch: output.etag!,
            FunctionConfig: {
              Comment: news.comment ?? "",
              Runtime: news.runtime ?? output.runtime,
              KeyValueStoreAssociations: toKvAssociations(news.keyValueStoreArns),
            },
            FunctionCode: encoder.encode(news.code),
          });

          const developmentEtag = yield* getDevelopmentEtag(output.functionName);
          const live = yield* publish(output.functionName, developmentEtag);
          if (!live?.FunctionSummary) {
            return yield* Effect.fail(
              new Error("publishFunction returned no function summary"),
            );
          }

          yield* session.note(output.functionName);
          return toAttrs(live.FunctionSummary, live.ETag, output.functionName);
        }),
        delete: Effect.fn(function* ({ output }) {
          yield* cloudfront
            .deleteFunction({
              Name: output.functionName,
              IfMatch: output.etag!,
            })
            .pipe(
              Effect.catchTag("NoSuchFunctionExists", () => Effect.void),
            );
        }),
      };
    }),
  );
