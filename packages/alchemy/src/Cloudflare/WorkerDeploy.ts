/**
 * The **Cloudflare deployment** of the portable `Alchemy.Worker`.
 *
 * `Cloudflare.Worker(cls, props, implOrDefinition)` is the deploy module:
 * it constructs the NATIVE `Cloudflare.Worker` resource from the
 * cloud-free impl — the native platform owns exports, Durable Object
 * class migrations, bundling, workers.dev / domain / route management —
 * and emits the `Deployment` proof. `Cloudflare.Worker.ref(cls)` lets
 * callers bind to the worker, consuming that proof and yielding the
 * platform-agnostic `HostRef` (identity, connection env keys, the
 * fetch-RPC remote transport, and the caller binding).
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
import type { DeploymentService, HostRef } from "../Worker/Engine.ts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import { Random } from "../Random.ts";
import { makeFetchRpcStub } from "../Rpc.ts";
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
  makeWorkerDeploy,
  type WorkerDeployAdapter,
} from "../Worker/Deploy.ts";
import {
  WorkerTarget as GenericWorkerTarget,
  type HostRefService,
  type WorkerTargetService,
} from "../Worker/Engine.ts";
import { makeRpcStub } from "./Workers/Rpc.ts";
import type { WorkerProps } from "./Workers/Worker.ts";

export const CLOUDFLARE_ENGINE = "cloudflare";

/**
 * The Cloudflare-specific deployment config the deploy wrapper forwards
 * to the native `Cloudflare.Worker` platform. A strict subset of the
 * native {@link WorkerProps} — `env` and `exports` are contributed by the
 * portable surface itself and must not be set here.
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
 * The Cloudflare per-cloud adapter provided around the worker impl.
 * Cloudflare itself needs no wrapper for its own DO calls, but remote
 * non-Cloudflare callers (a Lambda, an ECS task) reach hosted Durable
 * Objects through the alchemy RPC gateway; unmatched routes fall through
 * to the user's own fetch handler untouched.
 */
const cloudflareTarget: WorkerTargetService = {
  kind: CLOUDFLARE_ENGINE,
  wrapServe: (handler) => makeGatewayFetch(handler),
  durableObjectBinding: (declaration) => ({
    bindings: [
      {
        type: "durable_object_namespace" as const,
        name: declaration.name,
        className: declaration.className,
      },
    ],
  }),
  localDurableObject,
  remoteDurableObject,
};

/**
 * The logical id of the worker's gateway-secret {@link Random} resource.
 * Minted by the deploy wrapper (bound into the worker env) and re-yielded
 * by the ref's caller binding — resources are memoized by logical id, so
 * both sites resolve the SAME stack node and the secret stays stable
 * across deploys.
 */
const gatewaySecretId = (clsId: string) => `${clsId}GatewaySecret`;

/**
 * Cloudflare needs no network attachment — the caller just gets the
 * worker's URL and the gateway secret under the standard keys.
 */
const callerBinding =
  (clsId: string): HostRefService["callerBinding"] =>
  ({ worker, urlKey, secretKey }) =>
    Effect.gen(function* () {
      const secret = yield* Random(gatewaySecretId(clsId), { bytes: 32 });
      return {
        env: {
          [urlKey]: worker.url,
          [secretKey]: secret.text,
        },
      };
    });

/**
 * Build the Cloudflare deploy form. The native `Worker` const is passed in
 * by `Workers/Worker.ts` (which owns the public identifier) rather than
 * imported — that keeps this module out of Worker.ts's import cycle.
 */
export const makeCloudflareDeploy = (CloudflareWorker: any) => {
  const adapter: WorkerDeployAdapter<"cloudflare"> = {
    kind: CLOUDFLARE_ENGINE,
    target: cloudflareTarget,
    callerBinding,
    makeNative: (clsId, props: CloudflareWorkerTargetProps, impl) => {
      const nativeCls = (CloudflareWorker as any)(clsId);
      const nativeProps = Effect.gen(function* () {
        const env: Record<string, unknown> = {};
        // The gateway secret rides as a `secret_text` binding (the provider
        // lowers `Redacted` env values to secrets); `makeGatewayFetch` reads
        // it back from the worker env at runtime. At runtime the deploy
        // module re-executes, but the secret already lives in the deployed
        // env — mint nothing.
        if (!globalThis.__ALCHEMY_RUNTIME__) {
          const secret = yield* Random(gatewaySecretId(clsId), { bytes: 32 });
          env[FLEET_SECRET_VAR] = secret.text;
        }
        return { ...props, env } as WorkerProps;
      });
      return {
        layer: nativeCls.make(nativeProps, impl),
        instance: nativeCls.Self,
      };
    },
  };

  return makeWorkerDeploy(adapter);
};
