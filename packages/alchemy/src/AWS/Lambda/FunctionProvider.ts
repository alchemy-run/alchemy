/**
 * First-class live/local provider selection for Lambda Functions.
 *
 * Local mode still provisions a real Lambda, but substitutes a small bridge
 * bundle and executes the user's bundle in the persistent AWS dev sidecar.
 */
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Result from "effect/Result";
import * as Stream from "effect/Stream";
import { AlchemyContext } from "../../AlchemyContext.ts";
import * as Bundle from "../../Bundle/Bundle.ts";
import type { ScopedPlanStatusSession } from "../../Cli/Cli.ts";
import * as LocalProvider from "../../Local/LocalProvider.ts";
import * as ProviderLayer from "../../Local/ProviderLayer.ts";
import * as Provider from "../../Provider.ts";
import type { ResourceBinding } from "../../Resource.ts";
import { Stack } from "../../Stack.ts";
import type { PolicyStatement } from "../IAM/Policy.ts";
import { AWS_LOCAL_ENTRY_URL, localRuntimeServices } from "../LocalRuntime.ts";
import {
  Function,
  makeFunctionProvider,
  resolveFunctionBundleConfig,
  toTimeoutSeconds,
  type FunctionProps,
} from "./Function.ts";
import { bridgeCodeBundle } from "./Live/BridgeBundle.ts";
import { LiveLambdaRuntime } from "./Live/LiveRuntime.ts";

export const FunctionProvider = () =>
  ProviderLayer.dual(Function, {
    live: () => LiveFunctionProvider(),
    local: () =>
      LocalFunctionProvider().pipe(Layer.provide(localRuntimeServices())),
    modeTransition: "in-place",
  });

export const LiveFunctionProvider = () =>
  Provider.effect(Function, makeFunctionProvider());

const usableSession = (
  session: ScopedPlanStatusSession | undefined,
): ScopedPlanStatusSession =>
  typeof session?.note === "function"
    ? session
    : {
        note: (note: string) => Effect.logDebug(note),
        emit: () => Effect.void,
        done: () => Effect.void,
      };

const devTimeout = (
  timeout: Duration.Duration | undefined,
): Duration.Duration =>
  Duration.seconds(Math.max(toTimeoutSeconds(timeout) ?? 3, 60));

const sanitizeId = (id: string) => id.replace(/[^a-zA-Z0-9_-]/g, "-");

type FunctionBinding = ResourceBinding<Function["Binding"]>;

type LocalFunctionProviderRequirements =
  | AlchemyContext
  | FileSystem.FileSystem
  | LiveLambdaRuntime
  | Path.Path
  | Stack;

export const LocalFunctionProvider = () =>
  LocalProvider.make<
    Function,
    LocalProvider.DefaultLocalConfig<Function>,
    never,
    LocalFunctionProviderRequirements
  >(
    Function,
    AWS_LOCAL_ENTRY_URL,
    Effect.gen(function* () {
      const live = yield* makeFunctionProvider({
        bundleCode: () => bridgeCodeBundle,
      });
      const runtime = yield* LiveLambdaRuntime;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const { dotAlchemy } = yield* AlchemyContext;

      const liveBinding = (id: string): FunctionBinding => ({
        sid: "alchemy:live-lambda",
        data: {
          env: {
            ALCHEMY_LIVE_APPSYNC_HTTP: runtime.eventApi.httpEndpoint,
            ALCHEMY_LIVE_APPSYNC_REALTIME: runtime.eventApi.realtimeEndpoint,
            ALCHEMY_LIVE_FUNCTION_ID: id,
          },
          policyStatements: [
            {
              Sid: "AlchemyLiveLambda",
              Effect: "Allow",
              Action: [
                "appsync:EventConnect",
                "appsync:EventPublish",
                "appsync:EventSubscribe",
              ],
              Resource: [
                runtime.eventApi.apiArn,
                `${runtime.eventApi.apiArn}/*`,
              ],
            } satisfies PolicyStatement,
          ],
        },
      });

      const toDevProps = (props: FunctionProps): FunctionProps => ({
        ...props,
        handler: "handler",
        isExternal: true,
        timeout: devTimeout(props.timeout),
      });

      const toDevBindings = (id: string, bindings: FunctionBinding[]) => [
        ...bindings,
        liveBinding(id),
      ];

      const runWatch = Effect.fn(function* (
        id: string,
        props: FunctionProps,
        ready: Deferred.Deferred<void>,
      ) {
        const config = yield* resolveFunctionBundleConfig(props, {
          externalizeAwsSdk: false,
          registerRuntimeExtension: false,
        });
        const bundleDir = path.join(
          dotAlchemy,
          "local",
          "aws",
          "lambda",
          sanitizeId(id),
        );
        yield* fs.makeDirectory(bundleDir, { recursive: true });
        const handler = props.isExternal
          ? (props.handler ?? "default")
          : "default";
        let startedAt = Date.now();
        let firstBuild = true;

        yield* Bundle.watch(
          config.inputOptions,
          { ...config.outputOptions, dir: bundleDir },
          // Same built-in plugin configuration the deploy build uses, so the
          // locally-served bundle tree-shakes identically to the artifact.
          config.extra,
        ).pipe(
          Stream.tap((event) => {
            if (event._tag === "Start") {
              startedAt = Date.now();
            } else if (event._tag === "Error") {
              return Effect.logError(`[${id}] Build error`, event.error);
            }
            return Effect.void;
          }),
          Stream.filterMap((event) =>
            event._tag === "Success"
              ? Result.succeed(event.output)
              : Result.failVoid,
          ),
          Stream.mapEffect((bundle) =>
            Effect.gen(function* () {
              for (const file of bundle.files) {
                const filePath = path.join(bundleDir, file.path);
                yield* fs.makeDirectory(path.dirname(filePath), {
                  recursive: true,
                });
                if (typeof file.content === "string") {
                  yield* fs.writeFileString(filePath, file.content);
                } else {
                  yield* fs.writeFile(filePath, file.content);
                }
              }
              yield* runtime.setTarget(id, {
                bundlePath: path.join(bundleDir, "index.js"),
                handler,
              });
              yield* Effect.log(
                `[${id}] ${firstBuild ? "Serving locally" : "Rebuilt"} in ${Date.now() - startedAt}ms`,
              );
              firstBuild = false;
              yield* Deferred.succeed(ready, undefined);
            }).pipe(
              Effect.catchCause((cause) =>
                Effect.logError(`[${id}] Failed to serve locally`, cause),
              ),
            ),
          ),
          Stream.runDrain,
        );
      });

      return {
        precreate: Effect.fn(function* (args) {
          return yield* live.precreate!({
            ...args,
            news: toDevProps(args.news),
            bindings: toDevBindings(args.id, args.bindings),
            session: usableSession(args.session),
          });
        }),
        tail: live.tail,
        logs: live.logs,
        start: Effect.fn(function* (ctx) {
          if (ctx.news.durableConfig) {
            return yield* Effect.fail(
              new Error("Live Lambda does not support durable functions"),
            );
          }
          if (
            typeof ctx.news.url === "object" &&
            ctx.news.url.invokeMode === "RESPONSE_STREAM"
          ) {
            return yield* Effect.fail(
              new Error("Live Lambda does not support RESPONSE_STREAM"),
            );
          }

          const ready = yield* Deferred.make<void>();
          yield* runWatch(ctx.id, ctx.news, ready).pipe(Effect.forkScoped);
          yield* Deferred.await(ready).pipe(
            Effect.timeoutOrElse({
              duration: "120 seconds",
              orElse: () =>
                Effect.fail(
                  new Error(`[${ctx.id}] initial local build timed out`),
                ),
            }),
          );

          return yield* live.reconcile({
            id: ctx.id,
            fqn: ctx.fqn,
            instanceId: ctx.instanceId,
            news: toDevProps(ctx.news),
            olds: ctx.olds ? toDevProps(ctx.olds) : undefined,
            output: ctx.output,
            bindings: toDevBindings(ctx.id, ctx.bindings),
            session: usableSession(ctx.session),
          });
        }),
        deactivate: (ctx) => runtime.removeTarget(ctx.id),
        stop: Effect.fn(function* (ctx) {
          yield* live.delete({
            ...ctx,
            olds: toDevProps(ctx.olds),
            bindings: toDevBindings(ctx.id, ctx.bindings),
            session: usableSession(ctx.session),
          });
        }),
      } as LocalProvider.LocalProviderSpec<Function>;
    }),
  );
