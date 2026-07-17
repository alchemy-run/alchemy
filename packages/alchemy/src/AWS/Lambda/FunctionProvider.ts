/**
 * Provider selection for {@link Function}: the live (deploy) provider, or —
 * under `alchemy dev` — the Live Lambda provider, which deploys a bridge in
 * place of the user's code, runs the handler locally, and proxies every
 * invocation of the real Lambda to the developer's machine.
 */
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Result from "effect/Result";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { AlchemyContext } from "../../AlchemyContext.ts";
import * as Bundle from "../../Bundle/Bundle.ts";
import type { ScopedPlanStatusSession } from "../../Cli/Cli.ts";
import { isResolved } from "../../Diff.ts";
import * as RpcProvider from "../../Local/RpcProvider.ts";
import type { ResourceBinding } from "../../Resource.ts";
import { structuralSignature } from "../../Util/StructuralSignature.ts";
import { AWSEnvironment } from "../Environment.ts";
import type { PolicyStatement } from "../IAM/Policy.ts";
import { AWS_LOCAL_ENTRY_URL } from "../LocalRuntime.ts";
import {
  Function,
  LiveFunctionProvider,
  makeFunctionProvider,
  resolveFunctionBundleConfig,
  toTimeoutSeconds,
  type FunctionLifecycleInput,
  type FunctionProps,
} from "./Function.ts";
import { bridgeCodeBundle } from "./Live/BridgeBundle.ts";
import { LiveLambdaRuntime } from "./Live/LiveRuntime.ts";

export const FunctionProvider = () =>
  Layer.unwrap(
    Effect.gen(function* () {
      const context = yield* AlchemyContext;
      if (!context.dev) {
        return LiveFunctionProvider();
      }
      const environment = yield* AWSEnvironment.current;
      // A custom endpoint means a local emulator (floci/LocalStack): deploy
      // the real bundle into the emulator's Docker Lambda. The Live Lambda
      // bridge needs real AppSync Events, so it only runs against real AWS.
      return environment.endpoint
        ? LiveFunctionProvider()
        : LocalFunctionProvider();
    }),
  );

/**
 * Sessions crossing the RPC boundary lose their callables (functions
 * serialize to `null`) — fall back to plain logging.
 */
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

/**
 * Debugging through a live invocation needs more headroom than Lambda's 3s
 * default — floor the deployed bridge's timeout at 60s. The bridge itself
 * fails fast (16s) when no dev session is connected.
 */
const devTimeout = (
  timeout: Duration.Duration | undefined,
): Duration.Duration =>
  Duration.seconds(Math.max(toTimeoutSeconds(timeout) ?? 3, 60));

const sanitizeId = (id: string) => id.replace(/[^a-zA-Z0-9_-]/g, "-");

export const LocalFunctionProvider = () =>
  RpcProvider.effect(
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
      const rootScope = yield* Effect.scope;

      /**
       * Deploy-time wiring for the bridge, attached as a synthetic binding:
       * AppSync endpoints + function id via env, and IAM permissions to
       * connect/publish/subscribe on the shared Event API.
       */
      const liveBinding = (
        id: string,
      ): ResourceBinding<Function["Binding"]> => ({
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

      const devInputs = <
        T extends {
          news: FunctionProps;
          bindings: ResourceBinding<Function["Binding"]>[];
          session: ScopedPlanStatusSession;
        },
      >(
        id: string,
        args: T,
      ): T => ({
        ...args,
        news: {
          ...args.news,
          handler: "handler",
          timeout: devTimeout(args.news.timeout),
        },
        bindings: [...args.bindings, liveBinding(id)],
        session: usableSession(args.session),
      });

      const instances = new Map<
        string,
        {
          signature: string;
          scope: Scope.Closeable;
          ready: Deferred.Deferred<void>;
        }
      >();

      const dropInstance = Effect.fn(function* (id: string) {
        const existing = instances.get(id);
        if (!existing) return;
        instances.delete(id);
        yield* Scope.close(existing.scope, Exit.void);
      });

      /**
       * Watch → rebuild → hand the fresh bundle to {@link LiveLambdaRuntime}.
       * Lives in its own scope so a props change (or delete) can tear it down.
       */
      const runWatch = Effect.fn(function* (
        id: string,
        props: FunctionProps,
        ready: Deferred.Deferred<void>,
      ) {
        const config = yield* resolveFunctionBundleConfig(props);
        // Inside the project tree so the bundle's externalized imports
        // (@aws-sdk/*, native installs) resolve from the project's own
        // node_modules.
        const bundleDir = path.join(
          dotAlchemy,
          "local",
          "aws",
          "lambda",
          sanitizeId(id),
        );
        yield* fs.makeDirectory(bundleDir, { recursive: true });
        const handlerName = props.handler ?? "default";
        let start = Date.now();
        let status: "start" | "update" = "start";
        yield* Bundle.watch(config.inputOptions, {
          ...config.outputOptions,
          dir: bundleDir,
        }).pipe(
          Stream.tap((event) => {
            if (event._tag === "Start") {
              start = Date.now();
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
                if (typeof file.content === "string") {
                  yield* fs.writeFileString(filePath, file.content);
                } else {
                  yield* fs.writeFile(filePath, file.content);
                }
              }
              yield* runtime.setTarget(id, {
                bundlePath: path.join(bundleDir, "index.js"),
                handler: handlerName,
              });
              yield* Effect.log(
                `[${id}] ${status === "start" ? "Serving locally" : "Rebuilt"} in ${Date.now() - start}ms`,
              );
              status = "update";
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

      const ensureInstance = Effect.fn(function* (
        id: string,
        props: FunctionProps,
        bindings: ResourceBinding<Function["Binding"]>[],
      ) {
        const signature = yield* structuralSignature({ props, bindings });
        const existing = instances.get(id);
        if (existing?.signature === signature) {
          return yield* Deferred.await(existing.ready);
        }
        if (existing) {
          yield* dropInstance(id);
        }
        const scope = yield* Scope.fork(rootScope);
        const ready = yield* Deferred.make<void>();
        yield* runWatch(id, props, ready).pipe(Effect.forkIn(scope));
        instances.set(id, { signature, scope, ready });
        // Don't return until the first local build is servable — otherwise
        // an eager invocation of the freshly-deployed bridge would race the
        // build and fail with "not being served".
        yield* Deferred.await(ready).pipe(
          Effect.timeoutOrElse({
            duration: "120 seconds",
            orElse: () =>
              Effect.die(new Error(`[${id}] initial local build timed out`)),
          }),
        );
      });

      return {
        stables: live.stables,
        read: live.read,
        list: live.list,
        tail: live.tail,
        logs: live.logs,
        diff: Effect.fn(function* ({
          id,
          olds,
          news,
          newBindings,
        }: FunctionLifecycleInput<"diff">) {
          if (!isResolved(news) || !isResolved(newBindings)) return undefined;
          if (olds !== undefined && olds.functionName !== news.functionName) {
            return { action: "replace" as const };
          }
          const signature = yield* structuralSignature({
            props: news,
            bindings: newBindings,
          });
          if (instances.get(id)?.signature === signature) {
            return { action: "noop" as const };
          }
          return { action: "update" as const };
        }),
        precreate: Effect.fn(function* (
          args: FunctionLifecycleInput<"precreate">,
        ) {
          return yield* live.precreate!(devInputs(args.id, args));
        }),
        reconcile: Effect.fn(function* (
          args: FunctionLifecycleInput<"reconcile">,
        ) {
          const attributes = yield* live.reconcile(devInputs(args.id, args));
          yield* ensureInstance(args.id, args.news, args.bindings);
          return attributes;
        }),
        delete: Effect.fn(function* (args: FunctionLifecycleInput<"delete">) {
          yield* dropInstance(args.id);
          yield* runtime.removeTarget(args.id);
          yield* live.delete({
            ...args,
            session: usableSession(args.session),
          });
        }),
      };
    }),
  );
