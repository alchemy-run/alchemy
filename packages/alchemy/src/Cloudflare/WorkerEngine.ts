/**
 * The **Cloudflare deployment** of the portable `Alchemy.Worker`.
 *
 * `Cloudflare.Worker(cls, props, layer)` is the deploy module: it applies
 * the Cloudflare target to a cloud-free worker layer and emits the
 * `Deployment` proof, while `Cloudflare.Worker.ref(cls)` lets callers
 * bind to the worker — consuming that proof and yielding the
 * platform-agnostic `HostRef` (identity, connection env keys, and the
 * fetch-RPC remote transport).
 *
 * The matching **engine** (`Alchemy.WorkerEngine/cloudflare`, registered by
 * `Cloudflare.providers()`) owns the deployment lifecycle by DELEGATING to
 * the existing, battle-tested `Cloudflare.Worker` provider: the portable
 * worker's props + bindings are mapped onto the native `WorkerProps` /
 * binding contract and the provider performs the script upload, Durable
 * Object class migrations, workers.dev / domain / route management, and
 * deletion exactly as it does for natively-declared Workers.
 *
 * @section Deploying a Worker to Cloudflare
 * @example
 * ```typescript
 * export class Api extends Alchemy.Worker<Api>()("Api") {}
 *
 * export const ApiLive = Api.make(
 *   Effect.gen(function* () {
 *     const counters = yield* Counter;
 *     return { fetch: ... };
 *   }).pipe(Effect.provide(CounterLive)),
 * );
 *
 * export default Cloudflare.Worker(Api, { main: import.meta.url }, ApiLive);
 * ```
 *
 * @section Binding to a Cloudflare-deployed Worker
 * @example
 * ```typescript
 * export const WebLive = Web.make(
 *   Effect.gen(function* () {
 *     const counters = yield* Counter; // remote stub over the gateway
 *     return { fetch: ... };
 *   }).pipe(
 *     Effect.provide(
 *       CounterLive.pipe(Layer.provide(Cloudflare.Worker.ref(Api))),
 *     ),
 *   ),
 * );
 * ```
 */
import {
  Deployment,
  HostRef,
  type DeploymentService,
  type HostRefService,
} from "../Worker/Engine.ts";
import {
  resolveWorkerRef,
  workerConnectionKeys,
} from "../Worker/DurableObject.ts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import * as Artifacts from "../Artifacts.ts";
import type { ScopedPlanStatusSession } from "../Cli/Cli.ts";
import { InstanceId } from "../InstanceId.ts";
import * as Output from "../Output.ts";
import * as Provider from "../Provider.ts";
import type { ResourceBinding } from "../Resource.ts";
import { makeFetchRpcStub } from "../Rpc.ts";
import { RuntimeContext } from "../RuntimeContext.ts";
import { Stack } from "../Stack.ts";
// The gateway is engine-neutral runtime code (it routes
// `/{do}/{instance}/…` to whatever DO namespace bindings exist in the
// worker's env, gated on the shared `x-alchemy-fleet-secret` header); it
// lives in Celld/ for historical reasons but carries no celld deploy
// machinery, so it is reused directly rather than copied.
import {
  FLEET_SECRET_HEADER,
  FLEET_SECRET_VAR,
  makeGatewayFetch,
} from "../Celld/FleetGateway.ts";
import {
  WorkerEngine,
  WorkerTarget as GenericWorkerTarget,
  type WorkerBindingContract,
  type WorkerEngineService,
  type WorkerTargetService,
} from "../Worker/Engine.ts";
import type { GenericWorkerRuntimeContext } from "../Worker/RuntimeContext.ts";
import { getCompatibility } from "./Workers/Compatibility.ts";
import { makeRpcStub } from "./Workers/Rpc.ts";
import { WorkerBundle } from "./Workers/Sources/Rolldown.ts";
import {
  Worker as CloudflareWorker,
  type WorkerProps,
} from "./Workers/Worker.ts";

export const CLOUDFLARE_ENGINE = "cloudflare";

/**
 * The Cloudflare-specific deployment config a `Cloudflare.WorkerTarget`
 * forwards to the native `Cloudflare.Worker` provider. A strict subset of
 * the native {@link WorkerProps} — `env` and `exports` are contributed by
 * the portable surface itself and must not be set here.
 */
export interface CloudflareWorkerTargetProps extends Pick<
  WorkerProps,
  | "name"
  | "main"
  | "compatibility"
  | "workersDev"
  | "domain"
  | "routes"
  | "assets"
  | "build"
  | "bundle"
  | "rules"
  | "observability"
  | "cache"
  | "limits"
  | "placement"
  | "tags"
  | "logpush"
  | "crons"
  | "dev"
> {}

/** The Cloudflare local-stub flavor: the native JSRPC stub. */
const localDurableObject = (nativeBinding: any) =>
  makeRpcStub<any>(nativeBinding);

/**
 * The Cloudflare REMOTE transport: alchemy's fetch-RPC against the
 * worker's gateway — `POST {url}/{namespace}/{instance}/__rpc__/{method}`
 * with the gateway secret header. Bounded retry over transport errors and
 * not-reached gateway statuses (502/503/504); a 500 is NOT retried (the
 * request may have reached the object) but still fails the call, since the
 * RPC protocol answers 200 with an envelope and any other status is
 * infrastructure, never a value.
 */
const remoteDurableObject = ({
  url,
  secret,
  namespace,
}: {
  url: string;
  secret: string;
  namespace: string;
}) => ({
  getByName: (name: string) =>
    makeFetchRpcStub<any>({
      fetch: (request) =>
        Effect.gen(function* () {
          const client = yield* HttpClient.HttpClient;
          // The stub builds requests against its dummy default base —
          // graft the RPC path onto the worker's gateway URL.
          const rpcPath = new URL(request.url, "http://alchemy-rpc").pathname;
          return yield* client
            .execute(
              request.pipe(
                HttpClientRequest.setUrl(
                  `${url}/${encodeURIComponent(namespace)}/${encodeURIComponent(name)}${rpcPath}`,
                ),
                HttpClientRequest.setHeader(FLEET_SECRET_HEADER, secret),
              ),
            )
            .pipe(
              Effect.flatMap((response) =>
                response.status >= 300
                  ? response.text.pipe(
                      Effect.orElseSucceed(() => ""),
                      Effect.flatMap((body) =>
                        Effect.fail(
                          Object.assign(
                            new Error(
                              `worker gateway returned ${response.status}${body ? `: ${body.slice(0, 256)}` : ""}`,
                            ),
                            { status: response.status },
                          ),
                        ),
                      ),
                    )
                  : Effect.succeed(response),
              ),
              Effect.retry({
                while: (error): boolean =>
                  !(
                    typeof error === "object" &&
                    error !== null &&
                    "status" in error
                  ) ||
                  (error as { status: number }).status === 502 ||
                  (error as { status: number }).status === 503 ||
                  (error as { status: number }).status === 504,
                schedule: Schedule.exponential("500 millis"),
                times: 5,
              }),
            );
        }) as any,
      base: {
        fetch: () =>
          Effect.die(
            new Error(
              "HTTP fetch pass-through on a remote stub is not supported yet — call RPC methods, or send requests to the worker URL directly",
            ),
          ),
      },
    }),
});

/**
 * The Cloudflare target layer. With props the worker deploys to Cloudflare
 * through the `cloudflare` engine; with no props the layer is CLIENT-only,
 * supplying just the runtime behaviors (transport, stub flavors) so a
 * caller can reach a Cloudflare-deployed worker's Durable Objects.
 */
export const WorkerTarget = (
  props?: CloudflareWorkerTargetProps,
): Layer.Layer<GenericWorkerTarget> =>
  Layer.effect(
    GenericWorkerTarget,
    Effect.gen(function* () {
      const target: WorkerTargetService = {
        kind: CLOUDFLARE_ENGINE,
        props: { ...props },
        // Cloudflare itself needs no wrapper, but remote non-Cloudflare
        // callers (a Lambda, an ECS task) reach hosted Durable Objects
        // through the alchemy RPC gateway; unmatched routes fall through
        // to the user's own fetch handler untouched.
        wrapServe: (handler) => makeGatewayFetch(handler),
        localDurableObject,
        remoteDurableObject,
      };

      // Record the target on the ambient worker runtime context so the
      // platform folds it into the persisted Props.
      const ctx = yield* Effect.serviceOption(RuntimeContext).pipe(
        Effect.map(Option.getOrUndefined),
      );
      if (ctx !== undefined) {
        (ctx as GenericWorkerRuntimeContext).target = target;
      }
      return target;
    }),
  );

/** Unwrap a possibly-`Redacted` persisted secret to its raw string. */
const rawSecret = (value: unknown): string | undefined =>
  Redacted.isRedacted(value)
    ? String(Redacted.value(value as Redacted.Redacted<any>))
    : typeof value === "string" && value.length > 0
      ? value
      : undefined;

/**
 * Resolve the worker's gateway secret: reuse the persisted one (stable
 * across deploys so bound callers keep working), else mint a fresh
 * 32-byte hex secret.
 */
const resolveGatewaySecret = (existing: unknown) =>
  Effect.sync(() => {
    const raw = rawSecret(existing);
    if (raw !== undefined) {
      return Redacted.make(raw);
    }
    const bytes = new Uint8Array(32);
    globalThis.crypto.getRandomValues(bytes);
    return Redacted.make(
      Array.from(bytes)
        .map((b) => b.toString(16).padStart(2, "0"))
        .join(""),
    );
  });

/**
 * Fold the portable worker's Props + binding contributions into the native
 * Cloudflare {@link WorkerProps} the delegated provider consumes.
 */
const asCloudflareProps = (
  portable: Record<string, any>,
  extra?: {
    bindingEnv?: Record<string, unknown>;
    secret?: Redacted.Redacted<string>;
  },
): WorkerProps => {
  const target = (portable.target?.props ?? {}) as CloudflareWorkerTargetProps;
  const env: Record<string, unknown> = {
    ...portable.env,
    ...extra?.bindingEnv,
  };
  if (extra?.secret !== undefined) {
    // The gateway secret rides as a `secret_text` binding (the provider
    // lowers `Redacted` env values to secrets); `makeGatewayFetch` reads
    // it back from the worker env at runtime.
    env[FLEET_SECRET_VAR] = extra.secret;
  }
  return {
    ...target,
    env,
    exports: portable.exports,
  } as WorkerProps;
};

const noopSession: ScopedPlanStatusSession = {
  emit: () => Effect.void,
  done: () => Effect.void,
  note: () => Effect.void,
};

/**
 * The `cloudflare` {@link WorkerEngine}: the deployment lifecycle for
 * `Alchemy.Worker`s targeted at Cloudflare. Every operation delegates to
 * the native `Cloudflare.Worker` provider resolved from the ambient stack
 * context — script upload, Durable Object class migrations, workers.dev /
 * domain / route reconciliation, and deletion are the provider's, not
 * reimplemented here. Registered by `Cloudflare.providers()`.
 */
export const CloudflareWorkerEngine = (): Layer.Layer<
  WorkerEngine<"cloudflare">
> =>
  Layer.effect(
    WorkerEngine(CLOUDFLARE_ENGINE),
    Effect.gen(function* () {
      const stack = yield* Stack;

      /**
       * Translate the portable binding contract onto the native one: each
       * `durableObjects` declaration becomes a `durable_object_namespace`
       * binding (className drives the provider's class-migration engine;
       * the binding name is what the worker env exposes the namespace
       * under), and `env` contributions are folded into the worker's env.
       */
      const collectBindings = (
        bindings: { data?: WorkerBindingContract; action?: string }[],
      ) => {
        const active = (bindings ?? []).filter(
          (binding) => binding.action !== "delete",
        );
        const env: Record<string, unknown> = {};
        for (const binding of active) {
          Object.assign(env, binding.data?.env ?? {});
        }
        const cfBindings = active.flatMap((binding) => {
          const durableObjects = binding.data?.durableObjects ?? [];
          if (durableObjects.length === 0) {
            return [];
          }
          return [
            {
              sid: (binding as { sid?: string }).sid ?? durableObjects[0].name,
              data: {
                bindings: durableObjects.map((declaration) => ({
                  type: "durable_object_namespace" as const,
                  name: declaration.name,
                  className: declaration.className,
                })),
              },
            } satisfies ResourceBinding<CloudflareWorker["Binding"]>,
          ];
        });
        return { env, cfBindings };
      };

      // Mirrors the provider's `prepareBundle` exactly (same options, same
      // artifact-cache key) so a diff-time build is reused by the
      // reconcile in the same run and the hash matches what the provider
      // persists under `hash.bundle`.
      const buildBundle = (id: string, props: WorkerProps) =>
        Effect.gen(function* () {
          const bundler = yield* WorkerBundle;
          return yield* bundler.build({
            id,
            main: props.main!,
            compatibility: getCompatibility(props),
            entry: {
              kind: "effect",
              exports: props.exports ?? {},
            },
            stack: { name: stack.name, stage: stack.stage },
            extraOptions: props.build,
          });
        }).pipe(Artifacts.cached("build"));

      const findWorkerProvider = () => Provider.findProvider(CloudflareWorker);

      const currentInstanceId = (id: string) =>
        Effect.serviceOption(InstanceId).pipe(
          Effect.map(Option.getOrElse(() => id)),
        );

      return {
        kind: "Alchemy.WorkerEngine" as const,

        // The portable Props (env/target/exports) don't capture the code
        // itself, so the engine's default prop-comparison misses pure code
        // edits — compare the bundle hash against what the provider
        // persisted. Everything else (env, domain, routes, …) is
        // prop-visible and handled by the default update logic.
        diff: ({ id, news, output }) =>
          Effect.gen(function* () {
            const target: CloudflareWorkerTargetProps | undefined =
              news?.target?.props;
            if (output === undefined || typeof target?.main !== "string") {
              return undefined;
            }
            const bundle = yield* buildBundle(
              id,
              asCloudflareProps(news ?? {}),
            );
            if (bundle.hash !== output.hash?.bundle) {
              return { action: "update" as const };
            }
            return undefined;
          }),

        reconcile: Effect.fn(function* ({
          id,
          news,
          olds,
          output,
          bindings,
          session,
        }) {
          const target: CloudflareWorkerTargetProps = news.target?.props ?? {};
          if (typeof target.main !== "string") {
            return yield* Effect.die(
              new Error(
                `Alchemy.Worker '${id}' (cloudflare) requires a 'main' entry module on its target — ` +
                  "declare it: Cloudflare.WorkerTarget({ main: import.meta.url }).",
              ),
            );
          }

          const { env: bindingEnv, cfBindings } = collectBindings(
            bindings as any,
          );
          // Stable across deploys so caller bindings keep working; minted
          // on the first reconcile.
          const secret = yield* resolveGatewaySecret(output?.gatewaySecret);

          const provider = yield* findWorkerProvider();
          const instanceId = yield* currentInstanceId(id);
          yield* session.note("deploying Cloudflare Worker");
          const attributes = yield* provider.reconcile({
            id,
            fqn: id,
            instanceId,
            news: asCloudflareProps(news, { bindingEnv, secret }),
            olds: olds === undefined ? undefined : asCloudflareProps(olds),
            output: output as CloudflareWorker["Attributes"] | undefined,
            session: session as ScopedPlanStatusSession,
            bindings: cfBindings,
          });

          return {
            ...attributes,
            gatewaySecret: secret,
          };
        }),

        delete: Effect.fn(function* ({ id, olds, output }) {
          // Nothing was ever uploaded (e.g. a failed first reconcile) —
          // nothing to delete.
          if (output?.workerName === undefined) {
            return;
          }
          const provider = yield* findWorkerProvider();
          const instanceId = yield* currentInstanceId(id);
          yield* provider.delete({
            id,
            fqn: id,
            instanceId,
            olds: asCloudflareProps(olds ?? {}),
            output: output as CloudflareWorker["Attributes"],
            session: noopSession,
            bindings: [],
          });
        }),

        // Cloudflare needs no network attachment — the caller just gets
        // the worker's URL and the gateway secret under the standard keys.
        callerBinding: ({ worker, host: _host, urlKey, secretKey }) =>
          Effect.gen(function* () {
            const engineAttrs = worker.engine;
            return {
              env: {
                [urlKey]: Output.map(engineAttrs, (attrs: any) => attrs?.url),
                [secretKey]: Output.map(
                  engineAttrs,
                  (attrs: any) => attrs?.gatewaySecret,
                ),
              },
            };
          }),
      } satisfies WorkerEngineService;
    }),
  ) as Layer.Layer<WorkerEngine<"cloudflare">>;

/**
 * The Cloudflare **deploy module** form: apply the Cloudflare target to a
 * portable worker layer and emit the proof that this worker is deployed
 * here.
 *
 * The worker class is passed explicitly rather than recovered from the
 * layer because `Layer.provide` returns a fresh layer — an annotation on
 * the layer built by `Worker.make` would not survive
 * `WebLive.pipe(Layer.provide(...))`. Passing the class mirrors the
 * resource form's leading `id: string`; here the id is the tag.
 */
export const deployWorker = <Self, WOut, RIn>(
  cls: Effect.Effect<WOut, never, any>,
  props: CloudflareWorkerTargetProps,
  layer: Layer.Layer<Self, never, RIn | GenericWorkerTarget | HostRef>,
): Layer.Layer<
  Self | DeploymentService<WOut, "cloudflare">,
  never,
  Exclude<RIn, GenericWorkerTarget | HostRef>
> => {
  const clsId = resolveWorkerRef(cls as any).LogicalId;
  const selfRef = Layer.sync(HostRef, () => ({
    kind: CLOUDFLARE_ENGINE,
    workerId: clsId,
    // Never read on the hosting path (dispatch compares ids and hosts);
    // present so foreign-DO layers piped with their own ref are unaffected.
    worker: undefined,
    ...workerConnectionKeys(clsId),
    remoteDurableObject,
  }));
  const deployed = layer.pipe(
    Layer.provide(Layer.mergeAll(WorkerTarget(props), selfRef)),
  );
  const deployment = Layer.effect(
    Deployment<WOut, "cloudflare">(CLOUDFLARE_ENGINE, clsId),
    Effect.gen(function* () {
      const worker = yield* cls as unknown as Effect.Effect<WOut, never, never>;
      return { kind: CLOUDFLARE_ENGINE as "cloudflare", worker };
    }),
  );
  return deployment.pipe(Layer.provideMerge(deployed)) as Layer.Layer<
    Self | DeploymentService<WOut, "cloudflare">,
    never,
    Exclude<RIn, GenericWorkerTarget | HostRef>
  >;
};

/**
 * Assert — and prove — that `cls` is deployed to Cloudflare, yielding the
 * platform-agnostic {@link HostRef} a binder requires.
 *
 * The `Deployment` requirement is what propagates to the stack: only the
 * Cloudflare deploy module for this worker can discharge it, so pointing
 * a binder at a worker deployed elsewhere fails to compile.
 */
export const workerRef = <WOut>(
  cls: Effect.Effect<WOut, never, any>,
): Layer.Layer<HostRef, never, DeploymentService<WOut, "cloudflare">> =>
  Layer.effect(
    HostRef,
    Effect.gen(function* () {
      const clsId = resolveWorkerRef(cls as any).LogicalId;
      const { urlKey, secretKey } = workerConnectionKeys(clsId);
      const base = {
        kind: CLOUDFLARE_ENGINE,
        workerId: clsId,
        urlKey,
        secretKey,
        remoteDurableObject,
      };
      // Inside the deployed caller the layer stack re-executes, but the
      // stack-scoped Deployment proof is a plan-time construct — the
      // connection material arrives via the bound env instead.
      if (globalThis.__ALCHEMY_RUNTIME__) {
        return { ...base, worker: undefined };
      }
      const deployment = yield* Deployment<WOut, "cloudflare">(
        CLOUDFLARE_ENGINE,
        clsId,
      );
      return { ...base, worker: deployment.worker };
    }),
  );

/**
 * `Cloudflare.Worker` — the native resource/class factory, plus the
 * portable **deploy module** form and its `.ref` companion.
 *
 * The deploy form is discriminated by its first argument: the resource
 * forms lead with `id: string`, this one leads with the `Alchemy.Worker`
 * tag. Same position, same role — the id is just a tag.
 *
 * ```ts
 * export const ApiWorker = Cloudflare.Worker(Api, { main }, ApiLive);
 * export const WebWorker = Cloudflare.Worker(Web, { main },
 *   WebLive.pipe(Layer.provide(Cloudflare.Worker.ref(Api))));
 * ```
 *
 * Lives here rather than in `Workers/Worker.ts` because that module is
 * already in an import cycle with this one; re-exported by the barrel.
 */
export const Worker: typeof CloudflareWorker & {
  <Self, WOut, RIn>(
    cls: Effect.Effect<WOut, never, any>,
    props: CloudflareWorkerTargetProps,
    layer: Layer.Layer<Self, never, RIn | GenericWorkerTarget | HostRef>,
  ): Layer.Layer<
    Self | DeploymentService<WOut, "cloudflare">,
    never,
    Exclude<RIn, GenericWorkerTarget | HostRef>
  >;
  readonly ref: typeof workerRef;
} = Object.assign(
  (...args: any[]) =>
    // The portable deploy form leads with the tag; every native form
    // leads with a string id (or takes none at all).
    args.length === 3 && typeof args[0] !== "string"
      ? deployWorker(args[0], args[1], args[2])
      : (CloudflareWorker as any)(...args),
  CloudflareWorker,
  { ref: workerRef },
) as any;
